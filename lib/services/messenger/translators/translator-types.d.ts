/*
Copyright 2017 Resin.io

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
import { EmitInstructions, MessengerResponse, PrivacyPreference, TransmitInformation } from '../../messenger-types';

/** The metadata associated with a message that may be embedded in to the payload. */
export interface TranslatorMetadata {
	/** Message content, without any metadata. */
	content: string;
	/** Flow ID this this message was created on. */
	flow: string | null;
	/** The source for this message, to prevent infinite loops. */
	service: string | null;
	/** Whether this message should be hidden, because some services do not support such natively. */
	hidden: PrivacyPreference;
	/** Thread ID that this message was created on. */
	thread: string | null;
	/** Signature of the words in the associated message. */
	hmac?: string | null;
}

export interface PublicityIndicators {
	hidden: string;
	hiddenPreferred: string;
	shown: string;
}

export interface MetadataConfiguration {
	baseUrl: string;
	publicity: PublicityIndicators;
	secret: string;
}

/** Mapping of generic names for an event into equivalent specific events. */
export interface EventEquivalencies {
	/** Each messenger name for an event may have several service specific events. */
	[key: string]: string[];
}

/** A map of methods that may be used to convert payloads for emitting. */
export interface EmitConverters {
	/** A method to be used to translate each particular action. */
	[key: number /* MessengerAction */]: (message: TransmitInformation) => Promise<EmitInstructions>;
}

/** A map of methods that may be used to convert responses for bots. */
export interface ResponseConverters {
	/** A method to be used to translate each particular action. */
	[key: number /* MessengerAction */]:
		(message: TransmitInformation, response: any) => Promise<MessengerResponse>;
}

/** An enumerated list of the things that may go wrong with a translation. */
export const enum TranslatorErrorCode {
	WebServiceError, IncompleteTransmitInformation, ConfigurationError,
	ValueNotFound, EmitUnsupported, ResponseUnsupported, PermissionsError,
}
