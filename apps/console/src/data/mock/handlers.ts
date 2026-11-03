import type { OperationId, OperationInput, OperationOutput, Staff } from '@nem/contracts';

import type { MockState } from './state';

export interface MockContext {
  state: MockState;
  /** The caller's bearer token, as the http client would send it. */
  token: string | null;
  /** The staff member that token belongs to, if it is valid. */
  staff: Staff | null;
}

export type Handler<K extends OperationId> = (
  input: OperationInput<K>,
  ctx: MockContext,
) => OperationOutput<K> | Promise<OperationOutput<K>>;

export type Handlers = { [K in OperationId]?: Handler<K> };
