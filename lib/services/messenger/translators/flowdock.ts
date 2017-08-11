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
import { Session } from 'flowdock';
import * as _ from 'lodash';
import { FlowdockConnectionDetails, FlowdockEmitData, FlowdockEvent, FlowdockResponse } from '../../flowdock-types';
import { MessageContext, MessageEvent, MessageResponseData, TransmitContext } from '../../messenger-types';
import { DataHub } from '../datahubs/datahub';
import * as Translator from './translator';

export class FlowdockTranslator implements Translator.Translator {
	private hub: DataHub;
	private session: Session;
	private organization: string;
	private eventEquivalencies: {[generic: string]: string[]} = {
		message: ['message'],
	};

	constructor(data: FlowdockConnectionDetails, hub: DataHub) {
		this.hub = hub;
		this.session = new Session(data.token);
		this.organization = data.organization;
	}

	public eventTypeIntoMessageType(type: string): string {
		return _.findKey(this.eventEquivalencies, (value: string[]) => {
			return _.includes(value, type);
		}) || 'Misc event';
	}

	public messageTypeIntoEventTypes(type: string): string[] {
		return this.eventEquivalencies[type];
	}

	public getAllEventTypes(): string[] {
		return _.flatMap(this.eventEquivalencies, _.identity);
	}

	public eventIntoMessage(event: FlowdockEvent): Promise<MessageEvent> {
		// Separate out some parts of the message
		const metadata = Translator.extractMetadata(event.rawEvent.content, 'emoji');
		const titleAndText = metadata.content.match(/^(.*)\n--\n((?:\r|\n|.)*)$/);
		const flow = event.cookedEvent.flow;
		const thread = event.rawEvent.thread_id;
		const userId = event.rawEvent.user;
		const org = this.organization;
		const cookedEvent: MessageContext = {
			// action: MessageAction.Create,
			// first: event.rawEvent.id === event.rawEvent.thread.initial_message,
			details: {
				genesis: metadata.genesis || event.source,
				hidden: metadata.hidden,
				internal: !!event.rawEvent.external_user_name,
				text: titleAndText ? titleAndText[2].trim() : metadata.content.trim(),
				title: titleAndText ? titleAndText[1] : undefined,
			},
			source: {
				service: event.source,
				message: event.rawEvent.id,
				flow,
				thread,
				url: `https://www.flowdock.com/app/${org}/${flow}/threads/${thread}`,
				username: 'duff', // gets replaced
			},
		};
		// If the data provided a username
		if (event.rawEvent.external_user_name) {
			cookedEvent.source.username = event.rawEvent.external_user_name;
			return Promise.resolve({
				context: `${event.source}.${event.cookedEvent.context}`,
				type: this.eventTypeIntoMessageType(event.type),
				cookedEvent,
				rawEvent: event.rawEvent,
				source: event.source,
			});
		}
		return this.fetchFromSession(`/organizations/${org}/users/${userId}`)
			.then((user) => {
				cookedEvent.source.username = user.nick;
				return({
					context: `${event.source}.${event.cookedEvent.context}`,
					type: this.eventTypeIntoMessageType(event.type),
					cookedEvent,
					rawEvent: event.rawEvent,
					source: 'messenger',
				});
			});
	}

	public messageIntoConnectionDetails(message: TransmitContext): Promise<FlowdockConnectionDetails> {
		return this.hub.fetchValue(message.hubUsername, 'flowdock', 'token')
			.then((token) => {
				return {
					organization: this.organization,
					token,
				};
			});
	}

	public messageIntoCreateThread(message: TransmitContext): {method: string[], payload: FlowdockEmitData} {
		// Build a string for the title, if appropriate.
		const titleText = message.target.flow ? message.details.title + '\n--\n' : '';
		const org = this.organization;
		const flow = message.target.flow;
		return {method: ['_request'], payload: {
			htmlVerb: 'POST',
			path: `/flows/${org}/${flow}/messages/`,
			payload: {
				// The concatenated string, of various data nuggets, to emit
				content: titleText + message.details.text + '\n' + Translator.stringifyMetadata(message, 'emoji'),
				event: 'message',
				external_user_name: message.details.internal ? undefined : message.source.username.substring(0, 16),
				thread_id: message.target.thread,
			},
		}};
	}

	public responseIntoMessageResponse(payload: TransmitContext, response: FlowdockResponse): MessageResponseData {
		const thread = response.thread_id;
		const org = this.organization;
		const flow = payload.target.flow;
		const url = `https://www.flowdock.com/app/${org}/${flow}/threads/${thread}`;
		return {
			message: response.id,
			thread: response.thread_id,
			url,
		};
	}

	/**
	 * Utility function to structure the flowdock session as a promise.
	 * @param path    Endpoint to retrieve.
	 * @param search  Optional, some words which may be used to shortlist the results.
	 * @returns       Response from the session.
	 */
	private fetchFromSession = (path: string, search?: string): Promise<any> => {
		return new Promise<any>((resolve, reject) => {
			// The flowdock service both emits and calls back the error.
			// We're wrapping the emit in a promise reject and ignoring the error in callback
			this.session.on('error', reject);
			this.session.get(path, {search}, (_error?: Error, result?: any) => {
				this.session.removeListener('error', reject);
				if (result) {
					resolve(result);
				}
			});
		});
	}
}

export function createTranslator(data: FlowdockConnectionDetails, hub: DataHub): Translator.Translator {
	return new FlowdockTranslator(data, hub);
}
