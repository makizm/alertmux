import { EventEmitter } from 'node:events';

/**
 * In-process event bus feeding the SSE stream.
 *  - 'message' (MessageRow): a message was accepted or its status changed
 *  - 'event'   (EventRow):   a system event was logged
 *  - 'status'  (object):     listener/destination health changed
 */
export const bus = new EventEmitter();
bus.setMaxListeners(1000);
