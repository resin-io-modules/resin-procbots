/*
Copyright 2016-2017 Resin.io

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// VersionBot listens for merges of a PR to the `master` branch and then
// updates any packages for it.
import * as Promise from 'bluebird';
import * as FS from 'fs';
import * as GithubApi from 'github';
import * as _ from 'lodash';
import * as path from 'path';
import { cleanup, track } from 'temp';
import * as GithubApiTypes from '../apis/githubapi-types';
import { ProcBot } from '../framework/procbot';
import { ProcBotConfiguration } from '../framework/procbot-types';
import { GithubCookedData, GithubHandle, GithubLogin, GithubRegistration } from '../services/github-types';
import { ServiceEmitter, ServiceEvent, ServiceType } from '../services/service-types';
import { BuildCommand, ExecuteCommand } from '../utils/environment';
import { AlertLevel, LogLevel } from '../utils/logger';

// Exec technically has a binding because of it's Node typings, but promisify doesn't include
// the optional object (we need for CWD). So we need to special case it.
const fsReadFile: (filename: string, options?: any) => Promise<Buffer | string> = Promise.promisify(FS.readFile);
const fsWriteFile: (path: string, contents: string) => Promise<{}> = Promise.promisify(FS.writeFile);
const fsFileExists = Promise.promisify(FS.stat);
const tempMkdir = Promise.promisify(track().mkdir);
const tempCleanup = Promise.promisify(cleanup);

/** Stores data for a file retrieved from Github. */
interface EncodedFile extends FileMapping {
	/** The git tree entry the file belongs in. */
	treeEntry: GithubApiTypes.TreeEntry;
	/** The SHA for the blob that is the file. */
	blobSha: string;
};

/** Interface to store contents of a file extracted from a cloned git repo. */
interface FileMapping {
	/** The file contents. */
	file: string;
	/** The current format of encoding ('utf-8', 'base64' etc.) */
	encoding: string;
}

/** Used to pass the the PR and commit message for merging. */
interface MergeData {
	/** Commit message (version) to use as the merge message. */
	commitVersion: string;
	/** The PR that originated the merge. */
	pullRequest: GithubApiTypes.PullRequest;
}

/** Interface to pass relevant information into the blob creation method. */
interface RepoFileData {
	/** Owner of the repository to commit files to. */
	owner: string;
	/** Repository to commit files to. */
	repo: string;
	/** Branch to commit files to. */
	branchName: string;
	/** New version of the component to commit as. */
	version: string;
	/** The files to commit. */
	files: FileMapping[] | EncodedFile[];
}

/** The ReviewState enumerated type denotes an approved or blocked review. */
enum ReviewState {
	Approved = 0,
	ChangesRequired
};

/**
 * Interface used to store usernames of those who have reviewed, and the type of
 * review they gave. Note that commented reviews are ignored.
 */
interface ReviewerMap {
	/** Key is the username, value is the type of review. */
	[name: string]: ReviewState;
};

/** Interface to pass data required to run versionist on a repo. */
interface VersionistData {
	/** Auth token to use to clone the repository. */
	authToken: string;
	/** Branchname of the repo to clone. */
	branchName: string;
	/** Full path of the location where the repository should be cloned. */
	fullPath: string;
	/** Full name of the repository (owner/reponame). */
	repoFullName: string;
	/** The number of the PR for the repository. */
	number: number;
	/** Files that have been modified by running versionist. */
	files?: string[];
	/** The new version of the component. */
	version?: string;
}

/** Interface for passing errors around. */
interface VersionBotError {
	/** Brief error message. */
	brief: string;
	/** Detailed error message. */
	message: string;
	/** PR number the error occured in. */
	number: number;
	/** Owner of the repository. */
	owner: string;
	/** Repository name. */
	repo: string;
}

/** Relative (from root) filepath to the VersionBot configuration file in a repository. */
const RepositoryFilePath = 'repository.yml';
/** Message sent to required reviewers should they not have been added on a review. */
const ReviewerAddMessage = 'Please add yourselves as reviewers for this PR.';

/** Defines an interface for configuration-defined required tags. */
interface FooterTag {
	/** How many occurrences of the tag must be seen in a PR. */
	occurrence?: string;
	/** A RegExp defining the valid values for a tag. */
	values?: string;
	/** RegExp flags to use with the values property. */
	flags?: string;
}

/** Interface defining a set of FooterTag objects. */
interface FooterTags {
	[key: string]: FooterTag;
}

/** Interface for passing missing tags in a PR to a calling method. */
interface MissingTag {
	/** Name of the required tag missing. */
	name: string;
	/** Reason the tag failed. */
	reason: string;
}

/** The VersionBot specific ProcBot Configuration structure. */
interface VersionBotConfiguration extends ProcBotConfiguration {
	/** Minimum number of review approvals required to satisfy a review. */
	'minimum-approvals'?: number;
	/** A list of approved reviewers who count towards the minimum number of approvals. */
	reviewers?: string[];
	/** A list of approved maintainers (who also count as approved reviewers). */
	maintainers?: string[];
	/** Required commit footer tags. */
	'required-tags'?: FooterTags;
}

/** Interface for storing the result of each status check required on a PR and it's state. */
interface StatusResult {
	/** Name of the status check. */
	name: string;
	/** State of the status check. */
	state: StatusChecks;
}

/** State for the StatusResult interface. */
enum StatusChecks {
	/** Status check has passed. */
	Passed,
	/** Status check is currently being carried out. */
	Pending,
	/** Status check has failed. */
	Failed
};

/**
 * Allows the filtering of results from the `checkStatuses` method.
 * Depending on the `includeContexts` flag, results returned from the method:
 *   * Only include results from contexts listed in the `contexts` property (`includeContexts` is `true`)
 *   * Only include results from contexts not listed in the `contexts` property (`includeContexts` is `false`)
 */
interface StatusFilter {
	/** Whether this filter includes tags that should be included or excluded. */
	includeContexts: boolean;
	/** The list of status contexts to include or exclude. */
	contexts: string[];
}

/** Pull request type event. */
type GenericPullRequestEvent = GithubApiTypes.PullRequestEvent | GithubApiTypes.PullRequestReviewEvent;

/** Label to be applied for triggering VersionBot to carry out a merge. */
const MergeLabel = 'procbots/versionbot/ready-to-merge';
/** Label to be applied for VersionBot to ignore the PR. */
const IgnoreLabel = 'procbots/versionbot/no-checks';
/** Label denoting the PR is a work in progress and warnings should be suppressed. */
const WIPLabel = 'flow/in-progress';

/** Status context for versionist. */
const StatusVersionist = {
	/** Context name. */
	Context: 'Versionist',
	/** Status context message for versionist success. */
	Success: 'Found all required commit footer tags',
	/** Status context message for versionist failure. */
	Failure: 'Missing or forbidden tags in commits, see `repository.yml`',
	/** Status context message for the `procbots/versionbot/no-checks` label. */
	NoVersioning: 'Versioning for this PR is disabled'
};

/** Status context for reviewers. */
const StatusReviewers = {
	Context: 'Reviewers'
};

/** Status context for automatic (non-manual) merging. */
const StatusAutoMerge = {
	/** Context name. */
	Context: 'AutoMerges',
	/** Status context message for automatic merging success. */
	Success: 'PR merging is in progress',
	/** Status context message for automatic merging failure. */
	Pending: 'VersionBot should be used to merge PR',
	/** Status context message for the `procbots/versionbot/no-checks` label. */
	ManualMerge: 'Manual merging is in effect for this PR'
};

/**
 * The VersionBot is built on top of the ProcBot class, which does all the heavy lifting and scheduling.
 * It is designed to check for valid `versionist` commit semantics and alter (or merge) a PR
 * accordingly.
 */
export class VersionBot extends ProcBot {
	/**
	 * Determines whether an array of Labels includes the specified label name.
	 *
	 * @param labels     Array of Github Labels.
	 * @param labelName  The name of the label to search for.
	 * @returns            `true` if the label was found, `false` otherwise.
	 */
	private static hasLabel(labels: GithubApiTypes.Label[], labelName: string) {
		return _.some(labels, { name: labelName });
	}

	/** Github ServiceEmitter name. */
	private readonly githubEmitterName: string;
	/** Github App ServiceEmitter. */
	private githubEmitter: ServiceEmitter;
	/** Instance of Github SDK API in use for App. */
	private readonly githubApi: GithubApi;
	/** Email address used for commiting as VersionBot. */
	private emailAddress: string;

	/**
	 * Constructs a new VersionBot instance.
	 * @param app          Github App ID.
	 * @param name         Name of the VersionBot.
	 * @param email        Email ID to use for commits.
	 * @param pemString    PEM for Github events and App login.
	 * @param webhook      Secret webhook for validating events.
	 * @param pat          User PAT for final merges.
	 */
	constructor(integration: number, name: string, email: string, pemString: string, webhook: string) {
		// This is the VersionBot.
		super(name);
		this.emailAddress = email;

		// Create a new listener for Github with the right Integration ID.
		const ghListener = this.addServiceListener('github', {
			client: name,
			authentication: {
				appId: integration,
				pem: pemString,
				type: GithubLogin.App
			},
			path: '/webhooks',
			ingress: process.env.VERSIONBOT_LISTEN_PORT || 4567,
			type: ServiceType.Listener,
			webhookSecret: webhook
		});

		// Create a new emitter with the right App ID.
		const ghEmitter = this.addServiceEmitter('github', {
			authentication: {
				appId: integration,
				pem: pemString,
				type: GithubLogin.App
			},
			type: ServiceType.Emitter
		});

		// Throw if we didn't get either of the services.
		if (!ghListener) {
			throw new Error("Couldn't create a Github listener");
		}
		if (!ghEmitter) {
			throw new Error("Couldn't create a Github emitter");
		}
		this.githubEmitterName = ghEmitter.serviceName;
		this.githubEmitter = ghEmitter;

		// Github App API handle, used generally for most ops.
		this.githubApi = (<GithubHandle>this.githubEmitter.apiHandle).github;
		if (!this.githubApi) {
			throw new Error('No Github App API instance found');
		}

		// We have two different WorkerMethods here:
		// 1) Status checks on PR open and commits
		// 2) PR review and label checks for merge
		_.forEach([
			{
				name: 'CheckVersionistCommitStatus',
				events: [ 'pull_request' ],
				listenerMethod: this.checkFooterTags,
				suppressionLabels: [ IgnoreLabel ],
			},
			{
				name: 'CheckReviewerStatus',
				events: [ 'pull_request', 'pull_request_review' ],
				listenerMethod: this.checkReviewers,
			},
			{
				name: 'CheckForWaffleFlow',
				events: [ 'pull_request' ],
				listenerMethod: this.checkWaffleFlow,
			},
			{
				name: 'AddMissingReviewers',
				events: [ 'pull_request' ],
				listenerMethod: this.addReviewers,
			},
			{
				name: 'CheckForReadyMergeState',
				events: [ 'pull_request', 'pull_request_review' ],
				listenerMethod: this.mergePR,
				suppressionLabels: [ IgnoreLabel ],
				triggerLabels: [ MergeLabel ],
			},
			{
				name: 'NoChecksPassthrough',
				events: [ 'pull_request', 'pull_request_review' ],
				listenerMethod: this.passWithNoChecks,
				triggerLabels: [ IgnoreLabel ],
				suppressionLabels: [ MergeLabel ],
			},
			// Should a status change occur (Jenkins, VersionBot, etc. all succeed)
			// then check versioning and potentially go to a merge to master.
			{
				name: 'StatusChangeState',
				events: [ 'status' ],
				listenerMethod: this.statusChange,
			}
		], (reg: GithubRegistration) => {
			ghListener.registerEvent(reg);
		});
	}

	/**
	 * Looks for status change events and creates relevant PR events for any PR whose codebase changes
	 *
	 * @param _registration  GithubRegistration object used to register the method
	 * @param event          ServiceEvent containing the event information ('status' event)
	 * @returns              A void Promise once execution has finished.
	 */
	protected statusChange = (registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
		// We now use the data from the StatusEvent to mock up a PullRequestEvent with enough
		// data to carry out the checks.
		const splitRepo = event.cookedEvent.data.name.split('/');
		const owner = splitRepo[0];
		const repo = splitRepo[1];
		const commitSha = event.cookedEvent.data.sha;
		let prEvents: ServiceEvent[] = [];

		// If we made the status change, we stop now!
		switch (event.cookedEvent.data.context) {
			case StatusVersionist.Context:
			case StatusReviewers.Context:
			case StatusAutoMerge.Context:
				return Promise.resolve();

			default:
				break;
		}

		// Unfortunately, branches are only passed for the *base* branch, and not
		// the head (should it be a fork, for example). This means we actually have
		// to get every open PR on a base to determine the right PR based on the
		// head SHA. Unfortunately.
		// We *only* work on open states.
		return this.dispatchToEmitter(this.githubEmitterName, {
			data: {
				owner,
				repo,
				state: 'open'
			},
			method: this.githubApi.pullRequests.getAll
		}).then((foundPrs: GithubApiTypes.PullRequest[][]) => {
			const prs = _.flatten(foundPrs);

			// For each PR, attempt to match the SHA to the head SHA. If we get a match
			// we create a new prInfo and then hand them all to another map.
			_.each(prs, (pullRequest) => {
				if (pullRequest.head.sha === commitSha) {
					prEvents.push({
						cookedEvent: {
							data: {
								action: 'synchronize',
								pull_request: pullRequest,
								sender: {
									login: pullRequest.user.login
								}
							},
							githubApi: event.cookedEvent.githubApi,
							type: 'pull_request'
						},
						rawEvent: {
							pull_request: pullRequest,
							sender: {
								login: pullRequest.user.login
							}
						},
						source: this._botname
					});
				}
			});

			// We've an event for each PR. However, we now have to check the labels on it and a status event
			// does not include a PR. As we have already retrieved the right PR here, we filter out any that
			// have the suppression label on them.
			return Promise.delay(2000).then(() => {
				return Promise.filter(prEvents, (prEvent) => {
					const pr: GithubApiTypes.PullRequest = prEvent.cookedEvent.data.pull_request;

					return this.dispatchToEmitter(this.githubEmitterName, {
						data: {
							number: pr.number,
							owner: pr.base.repo.owner.login,
							repo: pr.base.repo.name,
						},
						method: this.githubApi.issues.getIssueLabels
					}).then((labels: GithubApiTypes.IssueLabel[]) => {
						if (!_.every(labels, (label) => label.name !== IgnoreLabel)) {
							this.logger.log(LogLevel.DEBUG,
								`Dropping '${registration.name}' as suppression labels are all present`);
							return false;
						}

						// Add the labels to the event.
						prEvent.cookedEvent.labels = labels;
						return true;
					});
				});
			});
		}).map((prEvent: ServiceEvent) => {
			return this.checkFooterTags(registration, prEvent);
		}).return();
	}

	/**
	 * Always passes Versionist and AutoMerge status if a no-checks label has been applied.
	 * This allows manual merging to correctly go ahead.
	 *
	 * @param _registration  GithubRegistration object used to register the method
	 * @param event          ServiceEvent containing the event information ('pull_request' event)
	 * @returns              A void Promise once execution has finished.
	 */
	protected passWithNoChecks = (_registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
		const pr = event.cookedEvent.data.pull_request;
		const head = event.cookedEvent.data.pull_request.head;
		const owner = head.repo.owner.login;
		const repo = head.repo.name;
		const prNumber = pr.number;

		this.logger.log(LogLevel.INFO, `Skipping AutoMerge and Versionist checks for ${owner}/${repo}#${prNumber}`);

		// Always set the automerge and versionist status to passing.
		return Promise.all([
			this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					context: StatusAutoMerge.Context,
					description: StatusAutoMerge.ManualMerge,
					owner,
					repo,
					sha: head.sha,
					state: 'success'
				},
				method: this.githubApi.repos.createStatus,
			}),
			this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					context: StatusVersionist.Context,
					description: StatusVersionist.NoVersioning,
					owner,
					repo,
					sha: head.sha,
					state: 'success'
				},
				method: this.githubApi.repos.createStatus,
			})
		]).return();
	}

	/**
	 * Checks for tags which require extra functionality to allow Waffleboard to operate upon the PR.
	 * Adds autogenerated text to the PR description for relevant tags.
	 *
	 * @param _registration  GithubRegistration object used to register the method
	 * @param event          ServiceEvent containing the event information ('pull_request' event)
	 * @returns              A void Promise once execution has finished.
	 */
	protected checkWaffleFlow = (_registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
		const pr = event.cookedEvent.data.pull_request;
		const base = event.cookedEvent.data.pull_request.base;
		const owner = base.repo.owner.login;
		const repo = base.repo.name;

		const prNumber = pr.number;
		const issues: string[] = [];
		const waffleString = '---- Autogenerated Waffleboard Connection: Connects to #';
		let body = pr.body;
		const generateWaffleReference = (text: string): void => {
			const regExp = /connects-to:\s+#([0-9]+)/gi;
			let match = regExp.exec(text);
			while (match) {
				const issueNumber = match[1];
				if (issues.indexOf(issueNumber) === -1) {
					issues.push(issueNumber);
				}
				match = regExp.exec(text);
			}
		};

		this.logger.log(LogLevel.INFO, `Checking ${owner}/${repo}#${prNumber} for potential Waffleboard connection ` +
			'comments');

		// Look at the PR body. Does it have a `Connects-To: #<number>` tag?
		// (We're only interested in local PRs and *not* cross-references).
		generateWaffleReference(pr.body);

		// Now look through all the commits in the PR. Do the same thing.
		return this.dispatchToEmitter(this.githubEmitterName, {
			data: {
				number: prNumber,
				owner,
				repo,
			},
			method: this.githubApi.pullRequests.getCommits
		}).then((commits: GithubApiTypes.Commit[]) => {
			// Go through all the commits. We're looking for, at a minimum, a 'change-type:' tag.
			for (let commit of commits) {
				generateWaffleReference(commit.commit.message);
			}

			// Now search the body for an autogenerated Waffle line for each issue.
			// For any we don't find, add one, next to the others.
			// We need to add the autogenerated lines to the footer, so we just append
			// these to the very end of the PR description.
			_.each(issues, (issue) => {
				if (body.indexOf(`${waffleString}${issue}`) === -1) {
					// Get last character of the body. If not a newline, we add one.
					let nlChar = '';
					if (body.charAt(body.length - 1) !== '\n') {
						nlChar = '\n';
					}
					body += `${nlChar}${waffleString}${issue}`;
				}
			});

			// Now update the PR description if we have extra changes.
			if (body !== pr.body) {
				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						body,
						number: prNumber,
						owner,
						repo,
					},
					method: this.githubApi.pullRequests.update
				});
			}
		});
	}

	/**
	 * Checks a freshly opened PR to see if there are any configured reviewers and maintainers.
	 * Should any valid reviewers and maintainers not already be assigned as reviewers on the PR, then
	 * a comment is posted on the PR directly asking those user logins to add themselves.
	 *
	 * @param _registration  GithubRegistration object used to register the method
	 * @param event          ServiceEvent containing the event information ('pull_request' event)
	 * @returns              A void Promise once execution has finished.
	 */
	protected addReviewers = (_registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
		const pr = event.cookedEvent.data.pull_request;
		const base = event.cookedEvent.data.pull_request.base;
		const owner = base.repo.owner.login;
		const repo = base.repo.name;
		const labels: GithubApiTypes.Label[] = event.cookedEvent.labels;
		let approvedMaintainers: string[];
		let approvedReviewers: string[];

		// Only when opening a new PR.
		if ((event.cookedEvent.data.action !== 'opened') || VersionBot.hasLabel(labels, WIPLabel)) {
			return Promise.resolve();
		}

		this.logger.log(LogLevel.INFO, `Checking reviewers list for ${owner}/${repo}#${pr.number}`);

		// Get the reviewers for the PR.
		return ProcBot.retrieveConfiguration({
			emitter: this.githubEmitter,
			location: {
				owner,
				repo,
				path: RepositoryFilePath
			}
		}).then((config: VersionBotConfiguration) => {
			approvedMaintainers = this.stripPRAuthor((config || {}).maintainers || null, pr) || [];
			approvedReviewers = this.stripPRAuthor((config || {}).reviewers || null, pr) || [];

			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					number: pr.number,
					owner,
					repo
				},
				method: this.githubApi.pullRequests.get
			});
		}).then((pullRequest: GithubApiTypes.PullRequest) => {
			// Look at the reviewers, create a list of configured reviewers that were not added
			// when the PR was opened.
			const assignedReviewers = _.map(pullRequest.requested_reviewers, (reviewer) => reviewer.login);
			const configuredReviewers = _.uniq(_.unionWith(approvedReviewers, approvedMaintainers));
			let missingReviewers = _.filter(configuredReviewers, (reviewer) => {
				return !(_.find(assignedReviewers, (assignedReviewer) => (assignedReviewer === reviewer)) ||
					(reviewer === pr.user.login));
			});

			// We don't assign the author as a reviewer, if they're in the list.
			// An App has no ability to create a review request. The best we can do is to create a new
			// comment pinging those missing in the list to add themselves.
			if (missingReviewers.length > 0) {
				let reviewerMessage = '';
				_.each(missingReviewers, (reviewer) => {
					reviewerMessage += `@${reviewer}, `;
				});
				reviewerMessage += ReviewerAddMessage;

				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						owner,
						repo,
						number: pr.number,
						body: reviewerMessage
					},
					method: this.githubApi.issues.createComment
				});
			}
		});
	}

	/**
	 * Checks to ensure that the minimum number of approvals for a PR occurs.
	 * Should the conditions be satisfied then a successful status is set, otherwise a failed
	 * state is set.
	 *
	 * @param _registration  GithubRegistration object used to register the method
	 * @param event          ServiceEvent containing the event information ('pull_request' event)
	 * @returns              A void Promise once execution has finished.
	 */
	protected checkReviewers = (_registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
		const pr = event.cookedEvent.data.pull_request;
		const base = event.cookedEvent.data.pull_request.base;
		const owner = base.repo.owner.login;
		const repo = base.repo.name;
		let botConfig: VersionBotConfiguration;

		this.logger.log(LogLevel.INFO, `Checking reviewer conditions for ${owner}/${repo}#${pr.number}`);

		// Get the reviews for the PR.
		return ProcBot.retrieveConfiguration({
			emitter: this.githubEmitter,
			location: {
				owner,
				repo,
				path: RepositoryFilePath
			}
		}).then((config: VersionBotConfiguration) => {
			botConfig = config;

			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					number: pr.number,
					owner,
					repo
				},
				method: this.githubApi.pullRequests.getReviews
			});
		}).then((reviews: GithubApiTypes.Review[]) => {
			// Zero is a falsey value, so we'll automatically catch that here.
			const approvalsNeeded = (botConfig || {})['minimum-approvals'] || 1;
			let approvedCount = 0;
			let reviewers: ReviewerMap = {};
			let status = '';
			let approvedPR = false;
			const approvedMaintainers = this.stripPRAuthor((botConfig || {}).maintainers || null, pr);
			const approvedReviewers = this.stripPRAuthor((botConfig || {}).reviewers || null, pr);

			// Sanity checks.
			// If less than one approval is needed, then there's probably a configuration error
			// we fail to review and report as an error.
			if (approvalsNeeded < 1) {
				return this.reportError({
					brief: 'Invalid number of approvals required',
					message: 'The number of approvals required to merge a PR is less than one. At least ' +
						`one approval is required. Please ask a maintainer to correct the \`minimum-approvals\` ` +
						`value in the config file (current value: ${approvalsNeeded})`,
					number: pr.number,
					owner,
					repo
				});
			}
			// If the length of the unique list of maintainers and reviewers is less than
			// the value of `approvalsNeeded`, then this is never going to work.
			// We only need to test if the `approvedReviewers` list is present
			if (approvedReviewers) {
				const mergedReviewers = _.unionWith(approvedReviewers, approvedMaintainers || [], _.isEqual);
				if (mergedReviewers.length < approvalsNeeded) {
					// We can never reach the number of approvals required. Comment on PR.
					return this.reportError({
						brief: 'Not enough reviewers for PR approval',
						message: 'The number of approved reviewers for the repository is less than the ' +
							`number of approvals that are required for the PR to be merged (${approvalsNeeded}).`,
						number: pr.number,
						owner,
						repo
					});
				}
			}

			// Cycle through reviews, ensure that any approved review occurred after any requiring changes.
			// Use a map for reviewers, as we'll need to know if they
			reviews.forEach((review: GithubApiTypes.Review) => {
				const reviewer = review.user.login;
				if (review.state === 'APPROVED') {
					reviewers[reviewer] = ReviewState.Approved;
				} else if (review.state === 'CHANGES_REQUESTED') {
					reviewers[reviewer] = ReviewState.ChangesRequired;
				}
			});

			// Filter any reviewers who are not in the approved reviewer list *or* in the maintainers
			// list.
			if (_.find(reviewers, (state) => state === ReviewState.ChangesRequired)) {
				status = 'Changes have been requested by at least one reviewer';
			} else {
				let reviewersApproved: string[] = _.map(reviewers, (_val, key) => key);
				let appendStatus = '';

				if (approvedReviewers || approvedMaintainers) {
					if (approvedReviewers) {
						reviewersApproved = _.filter(reviewersApproved, (reviewer) => {
							if (approvedReviewers && _.find(approvedReviewers, (login) => login === reviewer) ||
							(approvedMaintainers && _.find(approvedMaintainers, (login) => login === reviewer))) {
								return true;
							}

							return false;
						});
					}
				}

				// The list of reviewers is now filtered to those who are allowed to review.
				// If there is a list of maintainers, *at least one* needs to be in the list.
				// Big caveat, if the PR author is a maintainer, then we are not bound by the
				// rules. But they will need minimum approvals, and if there are two or more
				// maintainers, then another maintainer must approve.
				approvedCount = reviewersApproved.length;
				if (approvedMaintainers) {
					if (_.intersection(reviewersApproved, approvedMaintainers).length < 1) {
						approvedCount = (approvedCount >= approvalsNeeded) ? (approvalsNeeded - 1) : approvedCount;
						appendStatus = ' - Maintainer approval required';
					}
				}

				status = `${approvedCount}/${approvalsNeeded} review approvals met${appendStatus}`;
				approvedPR = (approvedCount >= approvalsNeeded) ? true : false;
			}

			// Finally set the reviewer status. This is a count of how many *valid* approved reviews have
			// been seen against the number required.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					context: StatusReviewers.Context,
					description: status,
					owner,
					repo,
					sha: pr.head.sha,
					state: approvedPR ? 'success' : 'failure'
				},
				method: this.githubApi.repos.createStatus
			});
		});
	}

	/**
	 * Checks the newly opened PR and its commits.
	 * 1. Triggered by an 'opened', 'synchronize' or 'labeled' event.
	 * 2. If the number of required tags and occurrences are present, we create a successful status,
	 *    otherwise we create a failed one.
	 * 3. If a version bump has occurred and everything is valid, merge the commit to `master`.
	 *
	 * @param _registration  GithubRegistration object used to register the method
	 * @param event          ServiceEvent containing the event information ('pull_request' event)
	 * @returns              A void Promise once execution has finished.
	 */
	protected checkFooterTags = (_registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
		const prEvent: GithubApiTypes.PullRequestEvent = event.cookedEvent.data;
		const pr = prEvent.pull_request;
		const head = pr.head;
		const base = pr.base;
		const owner = base.repo.owner.login;
		const name = base.repo.name;
		const author = prEvent.sender.login;
		const labels: GithubApiTypes.Label[] = event.cookedEvent.labels;
		const prAction = event.cookedEvent.data.action;
		const prLabel: GithubApiTypes.Label = event.cookedEvent.data.label;
		let committer = author;
		let lastCommit: GithubApiTypes.Commit;
		let botConfig: VersionBotConfiguration;

		// Only for opened, synced or labeling actions.
		if (!_.find(['opened', 'synchronize', 'labeled', 'unlabeled'], (action) => action === prAction)) {
			return Promise.resolve();
		}

		// If there's an unlabeling event, but it wasn't the IgnoreLabel being removed or the WIP label, then we
		// just return.
		if ((prAction === 'unlabeled') && ((prLabel.name !== IgnoreLabel) && (prLabel.name !== WIPLabel))) {
			return Promise.resolve();
		}

		// Always set the automerge status to failure.
		this.dispatchToEmitter(this.githubEmitterName, {
			data: {
				context: StatusAutoMerge.Context,
				description: StatusAutoMerge.Pending,
				owner,
				repo: name,
				sha: head.sha,
				state: 'pending'
			},
			method: this.githubApi.repos.createStatus,
		});

		this.logger.log(LogLevel.INFO, `Checking footer tags for ${owner}/${name}#${pr.number}`);

		// Get the configuration, if it exists, for this repo.
		return ProcBot.retrieveConfiguration({
			emitter: this.githubEmitter,
			location: {
				owner,
				repo: name,
				path: RepositoryFilePath
			}
		}).then((config: VersionBotConfiguration) => {
			botConfig = config;

			// Get all the commits on the repo.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					owner,
					number: pr.number,
					repo: name,
				},
				method: this.githubApi.pullRequests.getCommits
			});
		}).then((commits: GithubApiTypes.Commit[]) => {
			// For each tag we find, we adhere to some rules:
			//  * all - Every commit in the PR must contain the tag
			//  * once - At least one commit in the PR contains the tag
			//  * never - The tag must not occur in any commit in the PR
			const missingTags = this.checkCommitFooterTags(commits, botConfig);

			if (commits.length > 0) {
				lastCommit = commits[commits.length - 1];
				if (lastCommit.committer) {
					committer = lastCommit.committer.login;
				}
			}

			if (missingTags.length === 0) {
				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						context: StatusVersionist.Context,
						description: StatusVersionist.Success,
						owner,
						repo: name,
						sha: head.sha,
						state: 'success'
					},
					method: this.githubApi.repos.createStatus
				});
			}

			// Else we mark it as having failed and we inform the user directly in the PR.
			let tagNames = '';
			_.each(missingTags, (tag) => {
				tagNames += `${tag.name}, `;
			});
			this.logger.log(LogLevel.INFO, `Missing tags from accumulated commits: ${tagNames}` +
				`for ${owner}/${name}#${pr.number}`);

			// Go through the tags and compose a message.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					context: StatusVersionist.Context,
					description: StatusVersionist.Failure,
					owner,
					repo: name,
					sha: head.sha,
					state: 'failure'
				},
				method: this.githubApi.repos.createStatus,
			});
		}).then(() => {
			// Check statuses (including Versionist) on the PR.
			// Discount the reviewers context (as it's obvious as part of the PR), and the
			// automerge context, as we control that ourselves.
			return this.checkStatuses(pr, {
				includeContexts: false,
				contexts: [ StatusReviewers.Context, StatusAutoMerge.Context ]
			});
		}).then((checkStatus) => {
			// If any of them fail (*not* pending), then *if* we haven't already
			// commented (ie. we previously commented and there's been no commit
			// since), we ping the author of the PR and whinge at them.
			if ((checkStatus === StatusChecks.Failed) && !VersionBot.hasLabel(labels, WIPLabel)) {
				// Get the last commit. If there have been no comments *since* the
				// date of that commit, then we know that we can safely post a
				// comment telling the author of a failure. If there has, then
				// it's implicit that we made a comment.
				const lastCommitTimestamp = Date.parse(lastCommit.commit.committer.date);
				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						owner,
						repo: name,
						number: pr.number,
					},
					method: this.githubApi.issues.getComments
				}).then((comments: GithubApiTypes.Comment[]) => {
					// Check for any comments that come *after* the last commit
					// timestamp and is a Bot.
					if (_.some(comments, (comment: GithubApiTypes.Comment) => {
						return ((comment.user.type === 'Bot') &&
							(lastCommitTimestamp < Date.parse(comment.created_at)) &&
							!_.endsWith(comment.body, ReviewerAddMessage));
					})) {
						return Promise.resolve();
					}

					// Now we ping the author, telling them something went wrong.
					let warningUsers = '';
					warningUsers = `@${author}, `;
					if (author !== committer) {
						warningUsers += `@${committer}, `;
					}
					return this.dispatchToEmitter(this.githubEmitterName, {
						data: {
							body: `${warningUsers}status checks have failed for this PR. Please make appropriate `+
								'changes and recommit.',
							owner,
							number: pr.number,
							repo: name,
						},
						method: this.githubApi.issues.createComment,
					});
				});
			}
		}).then(() => {
			// If we don't have a relevant label for merging (or we do but the PR is marked as a WIP),
			// we don't proceed.
			if (VersionBot.hasLabel(labels, MergeLabel) && !VersionBot.hasLabel(labels, WIPLabel)) {
				if (pr.state === 'open') {
					return this.finaliseMerge(event.cookedEvent.data, pr);
				}
			}
		}).catch((err: Error) => {
			// Call the VersionBot error specific method.
			this.reportError({
				brief: `${process.env.VERSIONBOT_NAME} check failed for ${owner}/${name}#${pr.number}`,
				message: `${process.env.VERSIONBOT_NAME} failed to carry out a status check for the above pull ` +
					`request here: ${pr.html_url}. The reason for this is:\r\n${err.message}\r\n` +
					'Please carry out relevant changes or alert an appropriate admin.',
				number: pr.number,
				owner,
				repo: name
			});
		});
	}

	/**
	 * Merges a PR.
	 * 1. Triggered by a 'labeled' event ('procbots/versionbot/ready-to-merge') or a
	 *	'pull_request_review_comment'
	 * 2. Checks all review comments to ensure that at least one approves the PR (and that no comment
	 *	that may come after it includes a 'CHANGES_REQUESTED' state).
	 * 3. Commit new version upped files to the branch, which will cause a 'synchronized' event,
	 *	which will finalise the merge.
	 *
	 * It should be noted that this will, of course, result in a 'closed' event on a PR, which
	 * in turn will feed into the 'generateVersion' method.
	 *
	 * @param _registration  GithubRegistration object used to register the method
	 * @param event          ServiceEvent containing the event information ('pull_request' or 'pull_request_review'
	 *                       event)
	 * @returns              A void Promise once execution has finished.
	 */
	protected mergePR = (_registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
		// States for review comments are:
		//  * COMMENT
		//  * CHANGES_REQUESTED
		//  * APPROVED
		//
		// We *only* go through with a merge should:
		//  * The 'procbots/versionbot/ready-to-merge' label appear on the PR issue
		//  * All required statuses have been successful.
		// The latter overrides the label should it exist, as it will be assumed it is in error.
		const cookedData: GithubCookedData = event.cookedEvent;
		const data: GenericPullRequestEvent = cookedData.data;
		const pr = data.pull_request;
		const head = data.pull_request.head;
		const base = data.pull_request.base;
		const owner = base.repo.owner.login;
		const repo = base.repo.name;
		const labels: GithubApiTypes.Label[] = event.cookedEvent.labels;
		const headRepoFullName = `${head.repo.owner.login}/${head.repo.name}`;
		let newVersion: string;
		let fullPath: string;
		let branchName = pr.head.ref;
		let botConfig: VersionBotConfiguration;

		// Only carry out merging when the label has been applied and it's not a WIP.
		if ((cookedData.data.action !== 'labeled') || VersionBot.hasLabel(labels, WIPLabel)) {
			return Promise.resolve();
		}

		this.logger.log(LogLevel.INFO, `PR is ready to merge, attempting to carry out a ` +
			`version up for ${owner}/${repo}#${pr.number}`);

		// Get the reviews for the PR.
		return ProcBot.retrieveConfiguration({
			emitter: this.githubEmitter,
			location: {
				owner,
				repo,
				path: RepositoryFilePath
			}
		}).then((config: VersionBotConfiguration) => {
			botConfig = config;

			// Actually generate a new version of a component:
			// 1. Clone the repo
			// 2. Checkout the appropriate branch given the PR number
			// 3. Run `versionist`
			// 4. Read the `CHANGELOG.md` (and any `package.json`, if present)
			// 5. Base64 encode them
			// 6. Call Github to update them, in serial, CHANGELOG last (important for merging expectations)
			// 7. Finish

			// Check to ensure that the PR is actually mergeable. If it isn't, we report this as an
			// error, passing the state.
			if (pr.mergeable !== true) {
				throw new Error('The branch cannot currently be merged into master. It has a state of: ' +
					`\`${pr.mergeable_state}\``);
			}

			// Ensure that all the statuses required have passed (we ignore the automerge status).
			// If not, an error will be thrown and not proceed any further.
			return this.checkStatuses(pr, {
				includeContexts: false,
				contexts: [ StatusAutoMerge.Context ]
			});
		}).then((checkStatus) => {
			// Finally we have an array of booleans. If any of them are false,
			// statuses aren't valid.
			if ((checkStatus === StatusChecks.Failed) || (checkStatus === StatusChecks.Pending)) {
				throw new Error('checksPendingOrFailed');
			}

			// Ensure we've not already committed. If we have, we don't wish to do so again.
			return this.getVersionBotCommits(pr);
		}).then((commitMessage: string | null) => {
			if (commitMessage) {
				throw new Error(`alreadyCommitted`);
			}

			// If this was a labeling action and it's a pull_request event.
			if (cookedData.type === 'pull_request') {
				this.checkValidMaintainer(botConfig, cookedData.data);
			}

			// Create new work dir.
			return tempMkdir(`${repo}-${pr.number}_`);
		}).then((tempDir: string) => {
			fullPath = `${tempDir}${path.sep}`;

			return this.applyVersionist({
				authToken: cookedData.githubAuthToken,
				branchName,
				fullPath,
				repoFullName: headRepoFullName,
				number: pr.number
			});
		}).then((versionData: VersionistData) => {
			if (!versionData.version || !versionData.files) {
				throw new Error('Could not find new version!');
			}
			newVersion = versionData.version;

			// Read each file and base64 encode it.
			return Promise.map(versionData.files, (file: string) => {
				return fsReadFile(`${fullPath}${file}`)
				.then((buffer: Buffer) => {
					const encoding = buffer.toString('base64');
					let newFile: FileMapping = {
						file,
						encoding,
					};
					return newFile;
				});
			});
		}).then((files: FileMapping[]) => {
			return this.createCommitBlobs({
				branchName,
				files,
				owner,
				repo,
				version: newVersion
			});
		}).then(() => {
			this.logger.log(LogLevel.INFO, `Upped version of ${headRepoFullName}#${pr.number} to ` +
				`${newVersion}; tagged and pushed.`);
		}).catch((err: Error) => {
			// Call the VersionBot error specific method if this wasn't the short circuit for
			// committed code.
			if ((err.message !== 'alreadyCommitted') && (err.message !== 'checksPendingOrFailed')) {
				this.reportError({
					brief: `${process.env.VERSIONBOT_NAME} failed to merge ${headRepoFullName}#${pr.number}`,
					message: `${process.env.VERSIONBOT_NAME} failed to commit a new version to prepare a merge for ` +
						`the above pull request here: ${pr.html_url}. The reason for this is:\r\n${err.message}\r\n` +
						'Please carry out relevant changes or alert an appropriate admin.',
					number: pr.number,
					owner,
					repo
				});
			}
		}).finally(tempCleanup);
	}

	/**
	 * Clones a repository and runs `versionist` upon it, creating new change files.
	 *
	 * @param versionData  Information on the repository and version.
	 * @returns            Promise with added information on the repo.
	 */
	private applyVersionist(versionData: VersionistData): Promise<VersionistData> {
		// Clone the repository inside the directory using the commit name and the run versionist.
		// We only care about output from the git status.
		//
		// IMPORTANT NOTE: Currently, Versionist will fail if it doesn't find a
		//  `package.json` file. This means components that don't have one need a custom
		//  `versionist.conf.js` in their root dir. And we need to test to run against it.
		//  It's possible to get round this using a custom `versionist.conf.js`, which we now support.

		// We retry the clone up to three times, as we've seen issues in the past where GH doesn't
		// authenticate correctly. If it clones, then checkout should only fail if the branch isn't valid.
		return Promise.mapSeries([
			BuildCommand('git', ['clone', `https://${versionData.authToken}:${versionData.authToken}@github.com/` +
				`${versionData.repoFullName}`, `${versionData.fullPath}`],
				{ cwd: `${versionData.fullPath}`, retries: 3, delay: 5000 }),
			BuildCommand('git', ['checkout', `${versionData.branchName}`], { cwd: `${versionData.fullPath}` })
		], ExecuteCommand).then(() => {
			// Test the repo, we want to see if there's a local `versionist.conf.js`.
			// If so, we use that rather than the built-in default.
			return fsFileExists(`${versionData.fullPath}/versionist.conf.js`)
			.return(true)
			.catchReturn(false);
		}).catch(() => {
			// Sanitise the error so we send something cleaner up.
			throw new Error(`Cloning of branch ${versionData.branchName} in ${versionData.repoFullName} failed`);
		}).then((exists: boolean) => {
			let versionistCommand: string;
			let versionistArgs: string[] = [];

			return this.getNodeBinPath().then((nodePath: string) => {
				versionistCommand = path.join(nodePath, 'versionist');
				if (exists) {
					versionistArgs = ['-c', 'versionist.conf.js'];
					this.logger.log(LogLevel.INFO, 'Found an overriding versionist config ' +
						`for ${versionData.repoFullName}, using that`);
				}
			}).then(() => {
				return Promise.mapSeries([
					BuildCommand(versionistCommand, versionistArgs, { cwd: `${versionData.fullPath}` }),
					BuildCommand('git', ['status', '-s'], { cwd: `${versionData.fullPath}` })
				], ExecuteCommand).catch((err) => {
					throw new Error(`Versionist failed: ${err.message}`);
				});
			});
		}).then((commandResponses: string[]) => {
			const status = commandResponses[1];
			const moddedFiles: string[] = [];
			let changeLines = status.split('\n');
			let changeLogFound = false;

			if (changeLines.length === 0) {
				throw new Error(`Couldn't find any status changes after running 'versionist', exiting`);
			}
			changeLines = _.slice(changeLines, 0, changeLines.length - 1);
			// For each change, get the name of the change. We shouldn't see *anything* that isn't
			// expected, and we should only see modifications. Log anything else as an issue
			// (but not an error).
			changeLines.forEach((line) => {
				// If we get anything other than an 'M', flag this.
				const match = line.match(/^\sM\s(.+)$/);
				if (!match) {
					throw new Error(`Found a spurious git status entry: ${line.trim()}, abandoning version up`);
				} else {
					// Remove the status so we just get a filename.
					if (match[1] !== 'CHANGELOG.md') {
						moddedFiles.push(match[1]);
					} else {
						changeLogFound = true;
					}
				}
			});

			// Ensure that the CHANGELOG.md file is always the last and that it exists!
			if (!changeLogFound) {
				throw new Error(`Couldn't find the CHANGELOG.md file, abandoning version up`);
			}
			moddedFiles.push(`CHANGELOG.md`);

			// Now we get the new version from the CHANGELOG (*not* the package.json, it may not exist).
			return fsReadFile(`${versionData.fullPath}${_.last(moddedFiles)}`, { encoding: 'utf8' })
			.then((contents: string) => {
				// Only interested in the first match for '## v...'
				const match = contents.match(/^## (v[0-9]+\.[0-9]+\.[0-9]+).+$/m);

				if (!match) {
					throw new Error('Cannot find new version for ${repoFullName}-#${pr.number}');
				}

				versionData.version = match[1];
				versionData.files = moddedFiles;

				// Now we have to add the PR number and URL to every log entry we've just added for
				// the new version. This ensures that NotifyBot can apply release notes later on, if
				// required.
				const versions = contents.split('## ');

				// Now find the right version entry.
				for (let index = 0; index < versions.length; index += 1) {
					if (versions[index].startsWith(versionData.version)) {
						// Append the current PR number and URL for the PR after each
						// entry.
						versions[index] = versions[index].replace(/(\*[\s]+.*[\s]+)(\[.*])/gm,
							(_match, pattern1, pattern2) => {
								return `${pattern1}#${versionData.number} ${pattern2}`;
							});
					}
				}
				contents = versions.join('## ');

				// Write modified contents back.
				return fsWriteFile(`${versionData.fullPath}${_.last(moddedFiles)}`, contents);

			}).return(versionData);
		});
	}

	/**
	 * Updates all relevant repo files with altered version data.
	 *
	 * @param repoData  Repository and updated file information.
	 * @returns         Promise that resolves when git data has been updated.
	 */
	private createCommitBlobs(repoData: RepoFileData): Promise<void> {
		// We use the Github API to now update every file in our list, ending with the CHANGELOG.md
		// We need this to be the final file updated, as it'll kick off our actual merge.
		//
		// Turn all this into a single method, cleaner.
		// CommitEncodedFile, or something.
		let newTreeSha: string;

		// Get the top level hierarchy for the branch. It includes the files we need.
		return this.dispatchToEmitter(this.githubEmitterName, {
			data: {
				owner: repoData.owner,
				repo: repoData.repo,
				sha: repoData.branchName,
				recursive: true,
			},
			method: this.githubApi.gitdata.getTree
		}).then((treeData: GithubApiTypes.Tree) => {
			// We need to save the tree data, we'll be modifying it for updates in a moment.

			// Create a new blob for our files.
			// Explicit cast, we've transformed our initial list into a full mapping.
			return Promise.map(repoData.files as EncodedFile[], (file: EncodedFile) => {
				// Find the relevant entry in the tree.
				const treeEntry = _.find(treeData.tree, (entry: GithubApiTypes.TreeEntry) => {
					return entry.path === file.file;
				});

				if (!treeEntry) {
					throw new Error(`Couldn't find a git tree entry for the file ${file.file}`);
				}

				file.treeEntry = treeEntry;
				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						content: file.encoding,
						encoding: 'base64',
						owner: repoData.owner,
						repo: repoData.repo
					},
					method: this.githubApi.gitdata.createBlob
				}).then((blob: GithubApiTypes.Blob) => {
					if (file.treeEntry) {
						file.treeEntry.sha = blob.sha;
					}
				}).return(file);
			}).then((blobFiles: EncodedFile[]) => {
				// We now have a load of update tree path entries. We write the
				// data back to Github to get a new SHA for it.
				const newTree: GithubApiTypes.TreeEntry[] = [];

				blobFiles.forEach((file: EncodedFile) => {
					newTree.push({
						mode: file.treeEntry.mode,
						path: file.treeEntry.path,
						sha: file.treeEntry.sha,
						type: 'blob'
					});
				});

				// Now write this new tree and get back an SHA for it.
				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						base_tree: treeData.sha,
						owner: repoData.owner,
						repo: repoData.repo,
						tree: newTree
					},
					method: this.githubApi.gitdata.createTree
				});
			}).then((newTree: GithubApiTypes.Tree) => {
				newTreeSha = newTree.sha;

				// Get the last commit for the branch.
				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						owner: repoData.owner,
						repo: repoData.repo,
						sha: `${repoData.branchName}`
					},
					method: this.githubApi.repos.getCommit
				});
			}).then((lastCommit: GithubApiTypes.Commit) => {
				// We have new tree object, we now want to create a new commit referencing it.
				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						committer: {
							email: this.emailAddress,
							name: this._botname
						},
						message: `${repoData.version}`,
						parents: [ lastCommit.sha ],
						owner: repoData.owner,
						repo: repoData.repo,
						tree: newTreeSha
					},
					method: this.githubApi.gitdata.createCommit
				});
			}).then((commit: GithubApiTypes.Commit) => {
				// Finally, we now update the reference to the branch that's changed.
				// This should kick off the change for status.
				return this.dispatchToEmitter(this.githubEmitterName, {
					data: {
						force: false, // Not that I'm paranoid...
						owner: repoData.owner,
						ref: `heads/${repoData.branchName}`,
						repo: repoData.repo,
						sha: commit.sha
					},
					method: this.githubApi.gitdata.updateReference
				});
			});
		});
	}

	/**
	 * Carries out the merge to `master`, updating relevant references from prior commits.
	 * Deletes the old branch after merge has occured.
	 *
	 * @param data  Repo and commit data to be referenced.
	 * @returns     Promise that resolves when reference updates and merging has finalised.
	 */
	private mergeToMaster(data: MergeData): Promise<void> {
		const pr = data.pullRequest;
		const owner = pr.base.repo.owner.login;
		const repo = pr.base.repo.name;
		const prNumber = pr.number;

		return this.dispatchToEmitter(this.githubEmitterName, {
			data: {
				commit_title: `Auto-merge for PR #${prNumber} via ${process.env.VERSIONBOT_NAME}`,
				number: prNumber,
				owner,
				repo
			},
			method: this.githubApi.pullRequests.merge
		}).then((mergedData: GithubApiTypes.Merge) => {
			// We get an SHA back when the merge occurs, and we use this for a tag.
			// Note date gets filed in automatically by API.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					message: data.commitVersion,
					object: mergedData.sha,
					owner,
					repo,
					tag: data.commitVersion,
					tagger: {
						email: this.emailAddress,
						name: this._botname
					},
					type: 'commit'
				},
				method: this.githubApi.gitdata.createTag
			});
		}).then((newTag: GithubApiTypes.GitDataTag) => {
			// We now have a SHA back that contains the tag object.
			// Create a new reference based on it.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					owner,
					ref: `refs/tags/${data.commitVersion}`,
					repo,
					sha: newTag.sha
				},
				method: this.githubApi.gitdata.createReference
			});
		}).then(() => {
			// Delete the merge label. This will ensure future updates to the PR are
			// ignored by us.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					name: MergeLabel,
					number: prNumber,
					owner,
					repo
				},
				method: this.githubApi.issues.removeLabel
			});
		}).then(() => {
			// Finally delete this branch.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					owner,
					ref: `heads/${pr.head.ref}`,
					repo
				},
				method: this.githubApi.gitdata.deleteReference
			});
		}).catch((err: Error) => {
			// Sometimes a state can occur where a label attach occurs at the same time as a final status
			// check finishes. This actually causes two merge events to occur.
			// We supress the error in this event, as all previous checks have passed.
			// Any other issue will show up as a problem in the UI.
			if (err.message !== 'Pull Request is not mergeable') {
				throw err;
			}

			// Confidence check. We should see any issue that causes a PR to not be
			// mergeable show up as some sort of status in the UI. However, just in case,
			// here's a check to ensure the PR is still open. If it is, raise a
			// flag regardless of why.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					number: prNumber,
					owner,
					repo
				},
				method: this.githubApi.pullRequests.get
			}).then((mergePr: GithubApiTypes.PullRequest) => {
				if (mergePr.state === 'open') {
					throw err;
				}
			});
		});
	}

	/**
	 * Retrieve all protected branch status requirements, and determine the state for each.
	 * Status checks can be filtered to include or exclude the results of given contexts, if required.
	 *
	 * @param prInfo  The PR on which to check the current statuses.
	 * @param filter  An optional StatusFilter interface, allowing status contexts to be included/excluded
	 *                from results.
	 * @returns       Promise containing a StatusChecks object determining the state of each status.
	 */
	private checkStatuses(prInfo: GithubApiTypes.PullRequest, filter?: StatusFilter): Promise<StatusChecks> {
		// We need to check the branch protection for this repo.
		// Get all the statuses that need to have been satisfied.
		const base = prInfo.base;
		const head = prInfo.head;
		const owner = base.repo.owner.login;
		const repo = base.repo.name;
		let protectedContexts: string[] = [];
		const statusLUT: { [key: string]: StatusChecks; } = {
			failure: StatusChecks.Failed,
			pending: StatusChecks.Pending,
			success: StatusChecks.Passed,
		};

		// Now get all of the statuses required for the master branch.
		return this.dispatchToEmitter(this.githubEmitterName, {
			data: {
				branch: 'master',
				owner,
				repo
			},
			method: this.githubApi.repos.getProtectedBranchRequiredStatusChecks
		}).then((statusContexts: GithubApiTypes.RequiredStatusChecks) => {
			protectedContexts = statusContexts.contexts;

			// Get the statuses combined for this PR branch.
			return this.dispatchToEmitter(this.githubEmitterName, {
				data: {
					ref: head.sha,
					owner,
					repo
				},
				method: this.githubApi.repos.getCombinedStatus
			});
		}).then((statuses: GithubApiTypes.CombinedStatus) => {
			// Contexts need to be checked specifically.
			// Branch protection can include contexts that use prefixes which are then
			// suffixed to create more statuses.
			// For example, 'continuous-integration/travis-ci' contexts can end up as:
			//  * continuous-integration/travis-ci/push
			//  * continuous-integration/travis-ci/pr
			// statuses, which mean there are actually two checks per context and not one.
			//
			// The simplest way to check the contexts are therefore to get a list of
			// required status contexts (which we do anyway), then go through each
			// actual status check from the combined, and try and match the prefix of a context
			// with each status. If we get a hit, and the status is a failure, then we
			// have failed. If we match and the status is a pass, we've passed.
			// We can therefore assume that a pass has occurred if:
			//  * We have seen one of every context in the protected status list at least once
			//  AND
			//  * Each of those seen has passed
			// Should any protected context not be seen in the current status checks, then
			// we have failed.
			const statusResults: StatusResult[] = [];
			_.each(protectedContexts, (proContext) => {
				// We go through every status and see if the context prefixes the context
				// of the status.
				// We filter the VersionBot reviews.
				_.each(statuses.statuses, (status) => {
					if (_.startsWith(status.context, proContext)) {
						let includeContext = true;
						// If there's a filter, determine if the result should be included or excluded.
						if (filter) {
							const foundContext = _.find(filter.contexts, (context) => context === status.context);
							includeContext = filter.includeContexts ? foundContext !== undefined : !foundContext;
						}
						if (includeContext) {
							statusResults.push({
								name: status.context,
								state: statusLUT[status.state]
							});
						}
					}
				});
			});

			// If any of the checks are pending, we wait.
			if (_.some(statusResults, [ 'state', StatusChecks.Pending ])) {
				return StatusChecks.Pending;
			}

			// If any of the checks didn't pass, we fail.
			if (_.some(statusResults, [ 'state', StatusChecks.Failed ])) {
				this.logger.log(LogLevel.WARN, `Status checks failed: ${JSON.stringify(statusResults)}`);
				return StatusChecks.Failed;
			}

			// Else everything passed.
			return StatusChecks.Passed;
		});
	}

	/**
	 * Determines if VersionBot has already made commits to the PR branch for a version bump.
	 *
	 * @param prInfo    The PR to check.
	 * @returns         A Promise containing 'null' should VersionBot have not already committed, else the commit
	 *                  message itself.
	 */
	private getVersionBotCommits(prInfo: GithubApiTypes.PullRequest): Promise<string | null> {
		const owner = prInfo.head.repo.owner.login;
		const repo = prInfo.head.repo.name;

		// Get the list of commits for the PR, then get the very last commit SHA.
		return this.dispatchToEmitter(this.githubEmitterName, {
			data: {
				owner,
				repo,
				sha: prInfo.head.sha
			},
			method: this.githubApi.repos.getCommit
		}).then((headCommit: GithubApiTypes.Commit) => {
			const commit = headCommit.commit;
			const files = headCommit.files;

			if ((commit.committer.name === process.env.VERSIONBOT_NAME) &&
			_.find(files, (file: GithubApiTypes.CommitFile) => {
				return file.filename === 'CHANGELOG.md';
			})) {
				return commit.message;
			}

			return null;
		});
	}

	/**
	 * Finalises a merge should all checks have passed.
	 *
	 * @params data    A 'pull_request' event.
	 * @params prInfo  A pull request.
	 * @returns        Promise fulfilled when merging has finished.
	 */
	private finaliseMerge = (data: GithubApiTypes.PullRequestEvent,
	prInfo: GithubApiTypes.PullRequest): Promise<void> => {
		// We will go ahead and perform a merge if we see VersionBot has:
		// 1. All of the status checks have passed on the repo
		// 2. VersionBot has committed something with 'CHANGELOG.md' in it
		const head = prInfo.head;
		const owner = head.repo.owner.login;
		const repo = head.repo.name;

		// We need to exclude the automerge status, as versionbot itself is doing the merge.
		return this.checkStatuses(prInfo, {
			includeContexts: false,
			contexts: [ StatusAutoMerge.Context ]
		}).then((checkStatus) => {
			if (checkStatus === StatusChecks.Passed) {
				// Get the list of commits for the PR, then get the very last commit SHA.
				return this.getVersionBotCommits(prInfo).then((commitMessage: string | null) => {
					if (commitMessage) {
						// Ensure that the labeler was authorised. We do this here, else we could
						// end up spamming the PR with errors.
						return ProcBot.retrieveConfiguration({
							emitter: this.githubEmitter,
							location: {
								owner,
								repo,
								path: RepositoryFilePath
							}
						}).then((config: VersionBotConfiguration) => {
							// If this was a labeling action and there's a config, check to see if there's a maintainers
							// list and ensure the labeler was on it.
							// This throws an error if not.
							if (data.action === 'labeled') {
								this.checkValidMaintainer(config, data);
							}

							// Now we set the automerge context so that we can actually proceed with
							// the merge.
							return 	this.dispatchToEmitter(this.githubEmitterName, {
									data: {
										context: StatusAutoMerge.Context,
										description: StatusAutoMerge.Success,
										owner,
										repo,
										sha: head.sha,
										state: 'success'
									},
									method: this.githubApi.repos.createStatus,
								});
						}).then(() => {
							// We go ahead and merge.
							return this.mergeToMaster({
								commitVersion: commitMessage,
								pullRequest: prInfo
							});
						}).then(() => {
							// Report to console that we've merged.
							this.logger.log(LogLevel.INFO, `MergePR: Merged ${owner}/${repo}#${prInfo.number}`);
						}).catch((err: Error) => {
							// It's possible in some cases that we have to wait for a service that doesn't actually
							// present itself with status info until it's started. Jenkins is an example of this
							// which, when queried only responds 'pending' when the build's started.
							// In these cases, the compulsory status list won't include the particular service,
							// but the merge will notice that not every status on the branch protection has occurred.
							// We really don't want to a load of extra calls here, so we instead believe Github and
							// check for the standard return message and silently ignore it if present.
							if (!_.startsWith(err.message, 'Required status check')) {
								// We need to set the automerge status back to failure again, so that nobody
								// tries to merge this by mistake.
								this.dispatchToEmitter(this.githubEmitterName, {
									data: {
										context: StatusAutoMerge.Context,
										description: StatusAutoMerge.Pending,
										owner,
										repo,
										sha: head.sha,
										state: 'pending'
									},
									method: this.githubApi.repos.createStatus,
								});

								// Finally throw the error.
								throw err;
							}
						});
					}
				});
			}
		});
	}

	/**
	 * Strip the PR author from a list of user login string.
	 *
	 * @param list         The array of user logins.
	 * @param pullRequest  The pull request to use as a base.
	 * @returns            An array containing stripped user logins, or null should there be no valid users.
	 */
	private stripPRAuthor(list: string[] | null, pullRequest: GithubApiTypes.PullRequest): string[] | null {
		const filteredList = list ? _.filter(list, (reviewer) => reviewer !== pullRequest.user.login) : null;
		return (filteredList && (filteredList.length === 0)) ? null : filteredList;
	}

	/**
	 * Ensures that the merge label was added by a valid maintainer, should a list exist in the repo configuration.
	 *
	 * @param config	The VersionBot configuration object.
	 * @param event	 The PR event that triggered this check.
	 * @throws		  Exception should the maintainer not be valid.
	 */
	private checkValidMaintainer(config: VersionBotConfiguration, event: GithubApiTypes.PullRequestEvent): void {
		// If we have a list of valid maintainers, then we need to ensure that if the `ready-to-merge` label
		// was added, that it was by one of these maintainers *or* the author of the PR.
		const maintainers = (config || {}).maintainers;
		if (maintainers) {
			// A user is a 'special' maintainer, if all reviews have been approved.
			// Essentially this provides a mechanism for ensuring responsibility.
			maintainers.push(event.pull_request.user.login);

			// Get the user who added the label.
			if (!_.includes(maintainers, event.sender.login)) {
				let errorMessage = `The \`${MergeLabel}\` label was not added by an authorised ` +
					`maintainer or by the PR author. The ${maintainers.length} authorised mergers are:\n`;
				_.each(maintainers, (maintainer) => errorMessage = errorMessage.concat(`* @${maintainer}\n`));
				throw new Error(errorMessage);
			}
		}
	}

	/**
	 * Loops through all of the commits for a PR, ensuring that any required tags are present the
	 * specified number of times for a PR.
	 *
	 * @param allCommits  All of the commits for the PR.
	 * @param config      The config (if any) for the repository the PR belongs to.
	 * @returns           An array of MissingTag objects, denoting required tags not on the PR.
	 */
	private checkCommitFooterTags(allCommits: GithubApiTypes.Commit[], config: VersionBotConfiguration): MissingTag[] {
		const tagDefinitions = (config || {})['required-tags'] || {};
		const changeType = 'change-type';
		// Enumerated strings exist in 2.4, we'll move to those once the framework has.
		const tagOccurrences = [ 'all', 'once', 'never' ];
		const tagValueFlags = ['i', 'u', 'y', 'g', 'm']; // Last two ignored
		let sanitisedDefs: FooterTags = {};
		let tagCounts: { [key: string]: number } = {};

		// Filter the list of commits to those not made by VB.
		const commits = _.filter(allCommits, (commit) => commit.commit.committer.name !== process.env.VERSIONBOT_NAME);
		// Get and validate tag configs.
		_.each(_.mapKeys(tagDefinitions, (_value, key) => key.toLowerCase()), (tag: FooterTag, tagName) => {
			if (tagCounts[tagName]) {
				throw new Error(`More than one occurrence of a required footer tag (${tagName}) found ` +
					'in configuration');
			}
			if (tag.occurrence) {
				if ((typeof tag.occurrence !== 'string') ||
				!_.find(tagOccurrences, (occurrence) => tag.occurrence === occurrence)) {
					throw new Error(`Invalid occurrence value found for ${tagName} definition`);
				}
			}
			if (tag.values && tag.flags) {
				// Go through each character in the string, ensure that it's in the valid
				// flags definition.
				_.each(tag.flags, (char) => {
					if (!_.find(tagValueFlags, (flag) => flag !== char)) {
						throw new Error(`Invalid RegExp flags specific for ${tagName} definition`);
					}
				});
			}
			// Always use a lowered version of the tag.
			tagCounts[tagName] = 0;

			// Add to our sanitised definitions
			sanitisedDefs[tagName] = {
				occurrence: tag.occurrence,
				values: tag.values,
				flags: tag.flags
			};
		});

		// Always add the 'change-type' tag.
		sanitisedDefs[changeType] = sanitisedDefs[changeType] || {
				values: '\s*(patch|minor|major)\s*',
				flags: 'i'
		};
		tagCounts[changeType] = tagCounts[changeType] || 0;

		// Go through each commit. For each tag, we determine if it's present or not
		// and if it matches required values.
		for (let commit of commits) {
			const commitMessage: string = commit.commit.message;

			// Split the commits up into lines, and find the last line with any whitespace in.
			// Whilst we tend to ask for:
			//  <header>
			//
			//  <body>
			//
			//  <footer>
			// This code will actually let you get away with:
			//  <header>
			//
			//  <footer>
			// As sometimes a development patch may be self-explanatory in the header alone.
			const lines = commitMessage.split('\n');
			const lastLine = _.findLastIndex(lines, (line) => /^\s*$/.test(line));

			// If there's no match, then at the very least there's no footer, and the commit
			// is in the wrong format (as there's no text to use in the logs).
			if (lastLine > 0) {
				// We should have a line index to join from, now.
				lines.splice(0, lastLine);
				const footer = lines.join('\n');

				// For each tag, interrogate the footer and determine if the tag is
				// present.
				// We check for a valid instance of a tag. If there are duplicates,
				// potentially with invalid values, we don't flag it. This is primarily
				// as we don't know how scripts requiring these tags deal with them
				// and have to assume they'll pick a valid tag out.
				_.each(sanitisedDefs, (tag, name) => {
					// RE for the key. We want to capture the entire line
					const keyRE = new RegExp(`^${name}:(.*)$`, 'gmi');

					// We need to compile the RE for the value, if it doesn't already exist.
					// Strip the RE into a body and flags.
					let valueRE: RegExp = /.*/;
					if (tag.values) {
						// Get flag values, we ignore everything apart from 'i'.
						// Ensure we tack the end of input condition on.
						valueRE = new RegExp(`${tag.values}$`, tag.flags);
					}

					// Try and match the key.
					// We want all matches.
					let valueMatches = [];
					let match = keyRE.exec(footer);
					while (match) {
						valueMatches.push(match[1]);
						match = keyRE.exec(footer);
					}

					// Match the value.
					for (let valueMatch of valueMatches) {
						// Try and match the value returned, if any.
						const valueFound = valueMatch.match(valueRE);
						if (valueFound) {
							tagCounts[name]++;
							break;
						}
					}
				});
			}
		}

		// For each of the tags, now determine if the threshold occurrence has occurred.
		let tagResults: MissingTag[] = [];
		_.each(sanitisedDefs, (tag, name) => {
			// Lookup the tag in the tag map
			const tagCount = tagCounts[name] || 0;
			let tagsRequired = 0;

			// Convert all/never to numbers, appropriately. As we pre-validated
			// tags, we don't need to check for 'never' as that's the only
			// number left.
			if (tag.occurrence !== 'never') {
				// No tag occurrence or 'once'.
				tagsRequired = 1;

				if (tag.occurrence === 'all') {
					tagsRequired = commits.length;
				}

				if (tagCount < tagsRequired) {
					tagResults.push({
						name,
						reason: `Not enough occurrences of ${name} tag found in PR commits`
					});
				}
			} else {
				if (tagCount > 0) {
					tagResults.push({
						name,
						reason: `The ${name} tag was found when it should not be present in a PR commit`
					});
				}
			}

		});

		return tagResults;
	}

	/**
	 * Reports an error to the console and as a Github comment..
	 *
	 * @param error The error to report.
	 */
	private reportError(error: VersionBotError): Promise<void> {
		// Log to console.
		this.logger.alert(AlertLevel.ERROR, error.message);

		// Post a comment to the relevant PR, also detailing the issue.
		return this.dispatchToEmitter(this.githubEmitterName, {
			data: {
				body: error.message,
				number: error.number,
				owner: error.owner,
				repo: error.repo
			},
			method: this.githubApi.issues.createComment
		});
	}
}

/**
 * Creates a new instance of the VersionBot client.
 */
export function createBot(): VersionBot {
	const integrationId = (process.env.VERSIONBOT_INTEGRATION_ID) ?
		parseInt(process.env.VERSIONBOT_INTEGRATION_ID, 10) :
		NaN;
	if (
		process.env.VERSIONBOT_NAME &&
		process.env.VERSIONBOT_EMAIL &&
		_.isFinite(integrationId) &&
		process.env.VERSIONBOT_PEM &&
		process.env.VERSIONBOT_WEBHOOK_SECRET &&
		process.env.VERSIONBOT_USER
	) {
		return new VersionBot(
			integrationId,
			process.env.VERSIONBOT_NAME,
			process.env.VERSIONBOT_EMAIL,
			process.env.VERSIONBOT_PEM,
			process.env.VERSIONBOT_WEBHOOK_SECRET
		);
	}
	throw new Error('At least one required envvar for VersionBot is missing');
}
