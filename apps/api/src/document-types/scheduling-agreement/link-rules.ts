import type { LinkRule } from '@xbn/document-core';

/**
 * SCHEDULING_AGREEMENT doesn't originate links itself — it's a *target*
 * for SA releases, forecast docs, and (transitively) ASNs. The reverse
 * link rules (SA_RELEASE_* → SA, FORECAST_PUBLISH → SA, etc.) are
 * registered by those modules.
 */
export const schedulingAgreementLinkRules: ReadonlyArray<LinkRule> = [];
