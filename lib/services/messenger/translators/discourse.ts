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

import * as Promise from 'bluebird';
import * as _ from 'lodash';
import * as request from 'request-promise';
import {
	DiscourseConstructor, DiscourseEmitInstructions, DiscourseResponse,
} from '../../discourse-types';
import {
	BasicMessageInformation, CreateThreadResponse, IdentifyThreadResponse,
	MessengerAction, MessengerConstructor, MessengerEvent, TransmitInformation,
	UpdateThreadResponse,
} from '../../messenger-types';
import { ServiceScaffoldEvent } from '../../service-scaffold-types';
import { ServiceType } from '../../service-types';
import { DataHub } from '../datahubs/datahub';
import { Translator, TranslatorError } from './translator';
import { MetadataEncoding, TranslatorScaffold } from './translator-scaffold';
import { EmitConverters, ResponseConverters, TranslatorErrorCode } from './translator-types';

/**
 * Class to enable the translating between messenger standard forms and service
 * specific forms.
 */
export class DiscourseTranslator extends TranslatorScaffold implements Translator {
	/**
	 * Converts a provided message object into instructions to create a thread.
	 * @param message  object to analyse.
	 * @returns        Promise that resolves to emit instructions.
	 */
	private static createThreadIntoEmit(message: TransmitInformation): Promise<DiscourseEmitInstructions> {
		// Check that we have a title.
		const title = message.details.title;
		if (!title) {
			return Promise.reject(new TranslatorError(
				TranslatorErrorCode.IncompleteTransmitInformation, 'Cannot create a thread without a title.'
			));
		}
		// Bundle into a format for the service.
		return Promise.resolve({ method: ['request'], payload: {
			htmlVerb: 'POST',
			path: '/posts',
			body: {
				category: message.target.flow,
				raw: `${TranslatorScaffold.stringifyMetadata(message, MetadataEncoding.HiddenMD)}${message.details.text}`,
				title,
				unlist_topic: 'false',
			},
		}});
	}

	/**
	 * Converts a provided message object into instructions to create a message.
	 * @param message  object to analyse.
	 * @returns        Promise that resolves to emit instructions.
	 */
	private static createMessageIntoEmit(message: TransmitInformation): Promise<DiscourseEmitInstructions> {
		// Check we have a thread.
		const thread = message.target.thread;
		if (!thread) {
			return Promise.reject(new TranslatorError(
				TranslatorErrorCode.IncompleteTransmitInformation, 'Cannot create a comment without a thread.'
			));
		}
		// Bundle into a format for the service.
		return Promise.resolve({ method: ['request'], payload: {
			htmlVerb: 'POST',
			path: '/posts',
			body: {
				raw: `${TranslatorScaffold.stringifyMetadata(message, MetadataEncoding.HiddenMD)}${message.details.text}`,
				topic_id: thread,
				whisper: message.details.hidden ? 'true' : 'false',
			}
		}});
	}

	/**
	 * Converts a provided message object into instructions to read a thread for connections.
	 * @param message  object to analyse.
	 * @returns        Promise that resolves to emit instructions.
	 */
	private static readConnectionIntoEmit(message: TransmitInformation): Promise<DiscourseEmitInstructions> {
		// Check we have a thread.
		const thread = message.target.thread;
		if (!thread) {
			return Promise.reject(new TranslatorError(
				TranslatorErrorCode.IncompleteTransmitInformation, 'Cannot search for connections without a thread.'
			));
		}
		// Bundle into a format for the service.
		return Promise.resolve({ method: ['request'], payload: {
			htmlVerb: 'GET',
			path: '/search/query',
			qs: {
				term: `[${message.source.service} thread`,
				'search_context[type]': 'topic',
				'search_context[id]': thread,
			}
		}});
	}

	/**
	 * Converts a provided message object into instructions to update the tags.
	 * @param connectionDetails  Details to use to retrieve the topic slug.
	 * @param message            object to analyse.
	 * @returns                  Promise that resolves to emit instructions.
	 */
	private static updateTagsIntoEmit(
		connectionDetails: DiscourseConstructor, message: TransmitInformation
	): Promise<DiscourseEmitInstructions> {
		// Check that we have a thread.
		const thread = message.target.thread;
		if (!thread) {
			return Promise.reject(new TranslatorError(
				TranslatorErrorCode.IncompleteTransmitInformation, 'Cannot update tags without a thread.'
			));
		}
		// Check that we have an array of tags.
		const tags = message.details.tags;
		if (!_.isArray(tags)) {
			return Promise.reject(new TranslatorError(
				TranslatorErrorCode.IncompleteTransmitInformation, 'Cannot update tags without a tags array.'
			));
		}
		// Retrieve details of the topic, because tag updates need slug as well as ID.
		const getTopic = {
			json: true,
			method: 'GET',
			qs: {
				api_key: connectionDetails.token,
				api_username: connectionDetails.username,
			},
			url: `https://${connectionDetails.instance}/t/${message.target.thread}`,
		};
		return request(getTopic)
		.then((topicResponse) => {
			// Bundle into a format for the service.
			return { method: ['request'], payload: {
				body: {},
				htmlVerb: 'PUT',
				qs: {
					'tags[]': tags,
				},
				path: `/t/${topicResponse.slug}/${thread}.json`,
			}};
		});
	}

	/**
	 * Converts a response into a the generic format.
	 * @param instance  Name of the instance, used to properly populate the URL.
	 * @param _message  Not used, the initial message.
	 * @param response  The response provided by the service.
	 * @returns         Promise that resolves to emit instructions.
	 */
	private static convertCreateThreadResponse(
		instance: string, _message: TransmitInformation, response: DiscourseResponse
	): Promise<CreateThreadResponse> {
		return Promise.resolve({
			thread: response.topic_id,
			url: `https://${instance}/t/${response.topic_id}`
		});
	}

	/**
	 * Converts a response into a the generic format.
	 * @param message  The initial message that triggered this response.
	 * @param response  The response provided by the service.
	 * @returns         Promise that resolves to emit instructions.
	 */
	private static convertReadConnectionResponse(
		message: TransmitInformation, response: DiscourseResponse
	): Promise<IdentifyThreadResponse> {
		const idFinder = new RegExp(`${message.source.service} thread ([\\w\\d-+\\/=]+)`, 'i');
		if (response.posts.length > 0) {
			return Promise.resolve({
				thread: response.posts[0].blurb.match(idFinder)[1],
			});
		}
		return Promise.reject(new TranslatorError(
			TranslatorErrorCode.ValueNotFound, 'No connected thread found by querying Discourse.'
		));
	}

	/**
	 * Converts a response into a the generic format.
	 * @param _message   Not used, the initial message.
	 * @param _response  Not used, the response provided by the service.
	 * @returns          Promise that resolves to emit instructions.
	 */
	private static convertUpdateThreadResponse(
		_message: TransmitInformation, _response: DiscourseResponse
	): Promise<UpdateThreadResponse> {
		return Promise.resolve({});
	}

	protected eventEquivalencies = {
		message: ['post_created'],
	};
	protected emitConverters: EmitConverters = {
		[MessengerAction.CreateThread]: DiscourseTranslator.createThreadIntoEmit,
		[MessengerAction.CreateMessage]: DiscourseTranslator.createMessageIntoEmit,
		[MessengerAction.ReadConnection]: DiscourseTranslator.readConnectionIntoEmit,
	};
	protected responseConverters: ResponseConverters = {
		[MessengerAction.ReadConnection]: DiscourseTranslator.convertReadConnectionResponse,
		[MessengerAction.UpdateTags]: DiscourseTranslator.convertUpdateThreadResponse,
		[MessengerAction.CreateMessage]: DiscourseTranslator.convertUpdateThreadResponse,
	};
	private hubs: DataHub[];
	private connectionDetails: DiscourseConstructor;

	constructor(data: DiscourseConstructor, hubs: DataHub[]) {
		super();
		this.hubs = hubs;
		this.connectionDetails = data;
		// These converters require the injection of a couple of details from `this` instance.
		this.emitConverters[MessengerAction.UpdateTags] = _.partial(DiscourseTranslator.updateTagsIntoEmit, data);
		this.responseConverters[MessengerAction.CreateThread] =
			_.partial(DiscourseTranslator.convertCreateThreadResponse, data.instance);
	}

	/**
	 * Promise to convert a provided service specific event into messenger's standard form.
	 * @param event  Service specific event, straight out of the ServiceListener.
	 * @returns      Promise that resolves to the standard form of the message.
	 */
	public eventIntoMessage(event: ServiceScaffoldEvent): Promise<MessengerEvent> {
		// Encode once the common parts of a request
		const getGeneric = {
			json: true,
			method: 'GET',
			qs: {
				api_key: this.connectionDetails.token,
				api_username: this.connectionDetails.username,
			},
			// appended before execution
			uri: `https://${this.connectionDetails.instance}`,
		};
		// Gather more complete details of the enqueued event
		const getPost = _.cloneDeep(getGeneric);
		getPost.uri += `/posts/${event.rawEvent.id}`;
		const getTopic = _.cloneDeep(getGeneric);
		getTopic.uri += `/t/${event.rawEvent.topic_id}`;
		return Promise.props({
			post: request(getPost),
			topic: request(getTopic),
		})
		.then((details: {post: any, topic: any}) => {
			// Calculate metadata and resolve
			const metadata = TranslatorScaffold.extractMetadata(details.post.raw, MetadataEncoding.HiddenMD);
			// Generic has `-` at the end, Discourse has `_` at the beginning
			const convertedUsername = /^_/.test(details.post.username)
				? `${details.post.username.replace(/^_/, '')}-`
				: details.post.username
			;
			const cookedEvent: BasicMessageInformation = {
				details: {
					genesis: metadata.genesis || event.source,
					handle: convertedUsername,
					// post_type 4 seems to correspond to whisper
					hidden: details.post.post_type === 4,
					internal: details.post.staff,
					tags: details.topic.tags,
					text: metadata.content.trim(),
					title: details.topic.title,
				},
				source: {
					service: event.source,
					// These come in as integers, but should be strings
					flow: details.topic.category_id.toString(),
					message: details.post.id.toString(),
					thread: details.post.topic_id.toString(),
					url: getTopic.uri,
					username: convertedUsername,
				},
			};
			// Yield the object in a form suitable for service scaffold.
			return {
				context: `${event.source}.${event.cookedEvent.context}`,
				type: this.eventIntoMessageType(event),
				cookedEvent,
				rawEvent: event.rawEvent,
				source: 'messenger',
			};
		});
	}

	/**
	 * Promise to provide emitter construction details for a provided message.
	 * @param message  Message information, used to retrieve username
	 * @returns        Promise that resolves to the details required to construct an emitter.
	 */
	public messageIntoEmitterConstructor(message: TransmitInformation): Promise<DiscourseConstructor> {
		// Go looking through all the data hubs we've been provided for a token.
		const promises: Array<Promise<string>> = _.map(this.hubs, (hub) => {
			return hub.fetchValue(message.target.username, 'discourse', 'token');
		});
		// Generic has `-` at the end, Discourse has `_` at the beginning
		const convertedUsername = /-$/.test(message.target.username)
			? `_${message.target.username.replace(/-$/, '')}`
			: message.target.username
		;
		return Promise.any(promises)
		.then((token) => {
			// Pass back details that may be used to connect.
			return {
				token,
				username: convertedUsername,
				instance: this.connectionDetails.instance,
				type: ServiceType.Emitter,
			};
		});
	}

	/**
	 * Populate the listener constructor with details from the more generic constructor.
	 * Provided since the connectionDetails might need to be parsed from JSON and the server details might be instantiated.
	 * @param connectionDetails  Construction details for the service, probably 'inert', ie from JSON.
	 * @param genericDetails     Details from the construction of the messenger.
	 * @returns                  Connection details with the value merged in.
	 */
	public mergeGenericDetails(
		connectionDetails: DiscourseConstructor, genericDetails: MessengerConstructor
	): DiscourseConstructor {
		if (connectionDetails.server === undefined) {
			connectionDetails.server = genericDetails.server;
		}
		if (connectionDetails.type === undefined) {
			connectionDetails.type = genericDetails.type;
		}
		return connectionDetails;
	}
}

/**
 * Builds a translator that will convert Discourse specific information to and from Messenger format.
 * @param data  Construction details for creating a Discourse session.
 * @param hubs  A list of places to search for extra information, eg token.
 * @returns     A translator, ready to interpret Discourse's communications.
 */
export function createTranslator(data: DiscourseConstructor, hubs: DataHub[]): Translator {
	return new DiscourseTranslator(data, hubs);
}
