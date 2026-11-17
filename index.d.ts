/**
 * Reasons alalanet gives per option (more may come: under onHold "new" a hold with a reason the guard
 * does not know is refused). block: never paid. hold: paid as a new seller only when every reason is
 * unknown_service, not_checked_yet, not_rated_yet or pay_to_never_seen, besides info reasons.
 */
export type PreflightReason =
  // block
  | "pay_to_unknown" | "pay_to_zero_address" | "pay_to_burn_address" | "pay_to_is_asset" | "pay_to_sanctioned"
  | "pay_to_frozen_by_issuer" | "service_not_working" | "over_budget" | "quote_expired"
  // hold: the seller is new to alalanet
  | "unknown_service" | "not_checked_yet" | "not_rated_yet" | "pay_to_never_seen"
  // hold: compared against data
  | "pay_to_differs_from_listing" | "price_above_listing" | "price_above_observed" | "price_differs_from_description"
  | "network_not_listed" | "asset_not_stablecoin" | "price_not_comparable_to_budget" | "high_price" | "low_trust_score"
  // info
  | "pay_to_as_observed" | "pay_to_platform_wallet" | "amount_is_ceiling" | "frozen_status_unknown" | "testnet";

export interface PreflightOption {
  network: string;
  /** the option's network as the 402 spells it (eip155:8453); sent by alalanet since 2026-11-10 */
  network_id?: string;
  asset: string;
  amount: string;
  price: string;
  usd?: number;
  pay_to: string;
  decision: "allow" | "hold" | "block";
  reasons?: (PreflightReason | (string & {}))[];
  payment_hash: string;
}

export interface Decision {
  url: string;
  decision: "allow" | "hold" | "block";
  options: PreflightOption[];
  choose?: PreflightOption;
  expires_at: string;
  attestation?: unknown;
  service?: Record<string, unknown>;
  /** known flaws of the payment library you declared (client); not signed, not logged */
  client_advisories?: Advisory[];
}

export interface Advisory {
  id: string;
  package: string;
  below: string;
  from?: string;
  severity: "critical" | "high" | "medium";
  summary: string;
  fixed_in: string;
  source: string;
  published: string;
}

export interface Paid {
  url: string;
  /** false when the seller refused the payment (nothing was settled) */
  paid: boolean;
  status: number;
  /** settlement transaction hash from the PAYMENT-RESPONSE header */
  tx?: string;
  network?: string;
  payer?: string;
  usd: number;
  response: Response;
}

export interface GuardOptions {
  /** alalanet base URL (default https://alalanet.com) */
  api?: string;
  /** optional alalanet bearer token for higher limits */
  token?: string;
  /** options above this price are blocked by alalanet */
  maxUsdPerCall?: number;
  /** rolling 24 h budget kept in memory by this guard */
  maxUsdPerDay?: number;
  /** rolling 24 h budget per seller host, kept in memory by this guard */
  maxUsdPerHostPerDay?: number;
  /**
   * your x402 payment library and version, e.g. "@x402/fetch@2.23.0" (comma-separated for several).
   * Default: detected from the installed @x402/* packages (Node only). alalanet warns about known flaws.
   */
  client?: string;
  /** set false to skip detecting installed @x402/* versions */
  detectClient?: boolean;
  /** called once with known flaws of your payment library (default: console.warn) */
  onAdvisory?(advisories: Advisory[]): void;
  /** never pay these hosts ("api.example.com" or "*.example.com") */
  denyHosts?: string[];
  /** if set, pay only these hosts (with allowUrlPrefixes: a URL matching either list is paid) */
  allowHosts?: string[];
  /**
   * if set, pay only URLs that start with one of these ("https://api.example.com/v1/"): same origin, and
   * the path (with query) starts with the prefix's at a segment boundary; a path with an encoded "/",
   * "\" or ".", or with a ";", never matches. Refused otherwise with not_allowed_url.
   */
  allowUrlPrefixes?: string[];
  /**
   * the payee you expect, per host ("api.example.com", "*.example.com") or URL prefix ("https://...",
   * applied to every URL that starts with it): one address or several. Any other payTo for a matching
   * URL is refused (pay_to_unexpected). Look-alikes (same first and last four characters, another
   * address) of these and of payees this guard paid on the same host are refused (pay_to_lookalike);
   * an option alalanet allows is not compared with the paid ones. The hook learns a payee only from a
   * payment alalanet allowed (there the host is the one the 402 names).
   */
  expectPayTo?: Record<string, string | string[]>;
  /**
   * what to do with "hold" options (default "new"): "new" pays a hold whose only reasons say the seller
   * is new to alalanet (unknown_service, not_checked_yet, not_rated_yet, pay_to_never_seen, besides
   * information-only reasons), within the newSeller caps; "block" pays no hold (the 1.x default);
   * "allow" pays every hold. Hook: a new seller is not paid while allowHosts or allowUrlPrefixes is set
   * and the 402 names the URL, unless expectPayTo pins its payee or a resourceUrl function chose the URL.
   */
  onHold?: "new" | "block" | "allow";
  /** caps for holds paid by onHold "new" (default 0.05 USD a payment, 0.25 USD a rolling 24 h), in memory per guard object */
  newSeller?: { maxUsdPerCall?: number; maxUsdPerDay?: number };
  /**
   * if alalanet cannot be reached: refuse to pay (false, default) or let the payment go ahead unchecked
   * (true: the wrapper passes the 402 through, the hook does not abort); such a payment is not counted
   * against the hook's budgets
   */
  failOpen?: boolean;
  /** fetch used to call alalanet (default: globalThis.fetch) */
  fetch?: typeof fetch;
  /** put in front of the guard's own User-Agent on calls to alalanet, e.g. "my-agent/2" */
  userAgent?: string;
  onDecision?(d: Decision): void;
  /**
   * Wrapper only. Report each paid call to alalanet (POST /v1/purchases, verified on chain; no key needed).
   * true: "delivered" for 2xx, "not_delivered" otherwise. A function returns the outcome
   * ("delivered" | "partial" | "wrong_content" | "not_delivered") or null to skip.
   */
  report?: boolean | ((p: Paid) => "delivered" | "partial" | "wrong_content" | "not_delivered" | null | undefined);
  onReport?(r: { url: string; outcome: string; ok: boolean; status: number; result: unknown }): void;
  /** wrapper only: called after every payment attempt (check `paid`); use it to report the outcome (alalanet report_purchase) */
  onPaid?(p: Paid): void | Promise<void>;
  /**
   * Double-pay protection (default true). Wrapper: hold the signed payment per purchase (method + URL +
   * body) and re-present it on a retry while it is valid; after that, ask alalanet (payment_status, read
   * on chain) before a new payment may be signed. Hook: per resource (the URL the 402 names, e.g.
   * mcp://tool/<name>), refuse a second payment, to any payee, while the first is open (already_paid),
   * and after that one to another payee until 15 minutes after the first unless alalanet allows that
   * payee (pay_to_changed); a settled payment or a definite refusal ends that.
   * Set false to disable.
   */
  holdPayments?: boolean;
  /**
   * Wrapper only. A payee that took a payment on a host and answered without delivering (a non-2xx answer
   * that is not a definite refusal): "block" (default) refuses new payments to it on that host for the
   * guard's lifetime (not_delivered_before; a retry of the same purchase, method + URL + body, still
   * re-presents the held payment); "allow" pays it.
   */
  onNotDelivered?: "block" | "allow";
  /** called when a retry re-presents the held payment instead of a newly signed one */
  onRepresent?(e: { url: string; info: PaymentInfo }): void;
  /** called with alalanet's payment_status answer when the hold window has closed */
  onReconcile?(e: { url: string; status: PaymentStatus }): void;
}

export interface PaymentInfo {
  kind: "evm" | "svm";
  network: string;
  /** payer wallet */
  from: string;
  /** EVM exact: EIP-3009 nonce and validBefore (unix seconds) */
  nonce?: string;
  validBefore?: number;
  asset?: string;
  /** Solana exact: recent blockhash of the signed transaction */
  blockhash?: string;
}

export interface PaymentStatus {
  network: string;
  tx?: string;
  state: "settled" | "failed" | "pending" | "not_settled" | "expired_unsettled";
  retry: "do_not_pay_again" | "resend_same" | "new_payment_ok" | "wait";
  safe_to_sign_new: boolean;
  advice: string;
}

/** what the guard reads from a PAYMENT-SIGNATURE / X-PAYMENT value; null if it cannot be read */
export declare function paymentInfo(headerValue: string): PaymentInfo | null;
export declare function solanaPaymentInfo(txBase64: string): { signers: string[]; feePayer: string; blockhash: string };

export declare class X402GuardError extends Error {
  code:
    | "blocked" | "held" | "denied_host" | "not_allowed_host" | "not_allowed_url" | "over_budget" | "alalanet_unreachable"
    | "bad_402" | "already_paid" | "payment_outcome_unknown" | "pay_to_unexpected" | "pay_to_lookalike" | "not_delivered_before"
    | "not_approved";
  /** already_paid: the settlement transaction of the earlier payment */
  tx?: string;
  status?: PaymentStatus;
  url?: string;
  decision?: string;
  reasons?: string[];
  verdict?: Decision;
}

export declare function guardFetch(inner: typeof fetch, opts?: GuardOptions): typeof fetch;

/** Options for the official x402 client hook (alalanetGuard / alalanetHooks), besides GuardOptions. */
export interface HookOptions {
  /**
   * The https URL of the paid service to check. A string is used when the 402 names no https URL (a
   * paid MCP tool's resource is mcp://tool/<name> by default: pass your MCP server's URL). A function
   * gets the payment context and decides, even over an https URL the 402 names.
   */
  resourceUrl?: string | ((ctx: { paymentRequired: unknown; selectedRequirements: unknown }) => string | undefined);
  /** a payment without an https URL to check (also plain http:// sellers): refuse it (default "block") or let it through unchecked and uncounted */
  onUnchecked?: "block" | "allow";
  /** called when the hook refuses a payment; the client then throws "Payment creation aborted: x402-guard <code>: …" */
  onAbort?(a: {
    code:
      | "blocked" | "held" | "unchecked" | "denied_host" | "not_allowed_host" | "not_allowed_url" | "over_budget"
      | "alalanet_unreachable" | "cheaper_option" | "already_paid" | "pay_to_changed" | "pay_to_unexpected" | "pay_to_lookalike";
    message: string;
    url: string;
    decision?: string;
    reasons: string[];
    verdict?: Decision;
  }): void;
}

export interface GuardHooks {
  /**
   * for x402Client.onBeforePaymentCreation: judges the chosen option before it is signed; an approved
   * payment counts against the budgets from this moment
   */
  onBeforePaymentCreation(ctx: { paymentRequired: any; selectedRequirements: any }): Promise<void | { abort: true; reason: string }>;
  /** for x402Client.onAfterPaymentCreation: records the payee as paid and the payment's validBefore */
  onAfterPaymentCreation(ctx: { paymentRequired: any; selectedRequirements: any; paymentPayload: any }): Promise<void>;
  /** for x402Client.onPaymentResponse: a settled payment or a definite refusal ends the resource's open payment */
  onPaymentResponse(ctx: { paymentPayload: any; requirements: any; settleResponse?: any; paymentRequired?: any }): Promise<void>;
  /** for x402Client.onPaymentCreationFailure: a payment that was never created frees its share of the budgets */
  onPaymentCreationFailure(ctx: { paymentRequired: any; selectedRequirements: any; error: Error }): Promise<void>;
  /** for x402Client.registerPolicy: of the options to one payee on one network, asset and scheme, only the cheapest */
  policy(x402Version: number, requirements: any[]): any[];
}

/**
 * The hooks and the policy, to wire them yourself:
 *   const h = alalanetHooks(opts);
 *   client.registerPolicy(h.policy).onBeforePaymentCreation(h.onBeforePaymentCreation)
 *     .onAfterPaymentCreation(h.onAfterPaymentCreation).onPaymentCreationFailure(h.onPaymentCreationFailure)
 *     .onPaymentResponse(h.onPaymentResponse);
 */
export declare function alalanetHooks(opts?: GuardOptions & HookOptions): GuardHooks;

/**
 * Plug alalanet into the official x402 client (@x402/core x402Client): every payment it is about to
 * create is judged first, within your budgets. @x402/fetch, @x402/axios and @x402/mcp create payments
 * through this client, so one line covers them. Registers the policy and the four hooks the client
 * has. Returns the client.
 */
export declare function alalanetGuard<C extends {
  onBeforePaymentCreation(hook: GuardHooks["onBeforePaymentCreation"]): unknown;
  onPaymentCreationFailure(hook: GuardHooks["onPaymentCreationFailure"]): unknown;
  onAfterPaymentCreation?(hook: GuardHooks["onAfterPaymentCreation"]): unknown;
  onPaymentResponse?(hook: GuardHooks["onPaymentResponse"]): unknown;
  registerPolicy?(policy: GuardHooks["policy"]): unknown;
}>(client: C, opts?: GuardOptions & HookOptions): C;
