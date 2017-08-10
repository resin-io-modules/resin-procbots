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
import { UrlOptions } from 'request';
import { RequestPromiseOptions } from 'request-promise';
import { DiscourseService } from './discourse';
import { ServiceAPIHandle, ServiceEmitContext } from './service-types';
import { UtilityServiceEvent } from './service-utilities-types';

export interface DiscourseBasePayload {
	raw: string;
}

export interface DiscoursePostPayload extends DiscourseBasePayload {
	topic_id: string;
	whisper: string; // 'true'|'false';
}

export interface DiscourseTopicPayload extends DiscourseBasePayload {
	category: string;
	title: string;
	unlist_topic: string; // 'true'|'false';
}

export type DiscoursePayload = DiscoursePostPayload | DiscourseTopicPayload;

export type DiscourseResponse = any;

export interface DiscourseEmitContext extends ServiceEmitContext {
	data: DiscourseEmitData;
	method: DiscourseEmitMethod;
}

export type DiscourseEmitMethod = (requestOptions: UrlOptions & RequestPromiseOptions) => Promise<DiscourseResponse>;

export interface DiscourseEmitData {
	method: string;
	path: string;
	body?: DiscoursePayload;
	qs?: { [key: string]: string };
}

export interface DiscourseConnectionDetails {
	token: string;
	username: string;
	instance: string;
}

export interface DiscourseHandle extends ServiceAPIHandle {
	discourse: DiscourseService;
}

export interface DiscourseEvent extends UtilityServiceEvent {
}
