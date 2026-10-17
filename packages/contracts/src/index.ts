// Every API type comes from here. Never hand-write a type that duplicates the contract.
import type { components, operations, paths, webhooks } from './schema.gen';

export type { components, operations, paths, webhooks };

type Schemas = components['schemas'];

/** Any schema in the contract by name, e.g. `Schema<'Transfer'>`. */
export type Schema<Name extends keyof Schemas> = Schemas[Name];

// Shared building blocks.
export type Money = Schemas['Money'];
export type CurrencyCode = Schemas['CurrencyCode'];
export type Problem = Schemas['Problem'];
export type FieldError = Schemas['FieldError'];
export type PageInfo = Schemas['PageInfo'];
export type Health = Schemas['Health'];

// Core banking resources used across features.
export type User = Schemas['User'];
export type Device = Schemas['Device'];
export type AuthSession = Schemas['AuthSession'];
export type Account = Schemas['Account'];
export type Transaction = Schemas['Transaction'];
export type TransactionDetail = Schemas['TransactionDetail'];
export type Transfer = Schemas['Transfer'];
export type TransferStatus = Schemas['TransferStatus'];
export type RiskAssessment = Schemas['RiskAssessment'];
export type Beneficiary = Schemas['Beneficiary'];
export type Card = Schemas['Card'];
export type FxQuote = Schemas['FxQuote'];
export type AiMeta = Schemas['AiMeta'];

// Realtime: what the WebSocket pushes, narrowed by `type`.
export type RealtimeEvent = Schemas['RealtimeEvent'];
export type RealtimeEventType = RealtimeEvent['type'];
export type RealtimeEventOf<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>;
export type RealtimeClientMessage = Schemas['RealtimeClientMessage'];

// Staff console and developer platform.
export type Staff = Schemas['Staff'];
export type StaffRole = Schemas['StaffRole'];
export type ApprovalRequest = Schemas['ApprovalRequest'];
export type TrialBalance = Schemas['TrialBalance'];
export type JournalEntry = Schemas['JournalEntry'];
export type AuditEntry = Schemas['AuditEntry'];
export type ApiKey = Schemas['ApiKey'];
export type WebhookEvent = Schemas['WebhookEvent'];
