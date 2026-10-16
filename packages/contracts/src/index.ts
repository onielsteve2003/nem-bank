// Every API type comes from here. Never hand-write a type that duplicates the contract.
import type { components, operations, paths } from './schema.gen';

export type { components, operations, paths };

type Schemas = components['schemas'];

export type Money = Schemas['Money'];
export type CurrencyCode = Schemas['CurrencyCode'];
export type Problem = Schemas['Problem'];
export type FieldError = Schemas['FieldError'];
export type PageInfo = Schemas['PageInfo'];
export type Health = Schemas['Health'];
