import type { operations } from '@nem/contracts';

// Repository method types are derived from the generated OpenAPI operations, so a
// contract change shows up as a type error in every implementation (mock and http).

export type OperationId = keyof operations;

type Op<K extends OperationId> = operations[K];
type Params<K extends OperationId> = Op<K>['parameters'];

/** `{}` when the contract has no such part, optional when the part is optional. */
type Slot<Name extends string, T> = [NonNullable<T>] extends [never]
  ? unknown
  : undefined extends T
    ? { [P in Name]?: NonNullable<T> }
    : { [P in Name]: T };

type FirstContent<T> = T extends { content: infer C } ? C[keyof C] : never;

type Headers<K extends OperationId> = NonNullable<Params<K>['header']>;

/**
 * Only the headers the caller decides travel in the input. Device signatures, auth
 * and request IDs are added by the transport (http client, T3.11).
 */
type CallerHeaders<K extends OperationId> = ([Headers<K>] extends [never]
  ? unknown
  : Headers<K> extends { 'Idempotency-Key': string }
    ? { idempotencyKey: string }
    : unknown) &
  ([Headers<K>] extends [never]
    ? unknown
    : 'X-Step-Up-Token' extends keyof Headers<K>
      ? undefined extends Headers<K>['X-Step-Up-Token']
        ? { stepUpToken?: string }
        : { stepUpToken: string }
      : unknown);

type Simplify<T> = { [P in keyof T]: T[P] } & {};

/** What a repository method takes for operation `K`: path, query, body and caller headers. */
export type OperationInput<K extends OperationId> = Simplify<
  Slot<'path', Params<K>['path']> &
    Slot<'query', Params<K>['query']> &
    Slot<'body', FirstContent<NonNullable<Op<K>['requestBody']>>> &
    CallerHeaders<K>
>;

type SuccessStatus = 200 | 201 | 202 | 204;
type Responses<K extends OperationId> = Op<K>['responses'];
type SuccessResponse<K extends OperationId> = Responses<K>[Extract<
  keyof Responses<K>,
  SuccessStatus
>];

/** The success body for operation `K`; `void` for 204 responses. */
export type OperationOutput<K extends OperationId> = [FirstContent<SuccessResponse<K>>] extends [
  never,
]
  ? void
  : FirstContent<SuccessResponse<K>>;

export interface CallOptions {
  /** Aborts the call; TanStack Query passes one per query. */
  signal?: AbortSignal;
}

export type RepoMethod<K extends OperationId> =
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` tests "has no required keys"
  {} extends OperationInput<K>
    ? (input?: OperationInput<K>, options?: CallOptions) => Promise<OperationOutput<K>>
    : (input: OperationInput<K>, options?: CallOptions) => Promise<OperationOutput<K>>;

/** Method name → operation ID. One table gives both the runtime shape and the types. */
export type MethodMap = Readonly<Record<string, OperationId>>;

export type RepoOf<M extends MethodMap> = { readonly [Name in keyof M]: RepoMethod<M[Name]> };
