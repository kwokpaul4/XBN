/**
 * Shared building blocks for the create-document forms. Every downstream
 * doc type reuses the address block, the styles, and the small pattern
 * for picking a predecessor document (an ASN needs a PO / SA_RELEASE_JIT,
 * a GR needs an ASN, a Credit Memo needs an Invoice, and so on).
 *
 * Keeping these here means each of the 11 new form pages stays under ~200
 * lines and speaks the same visual language.
 */

import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';

export const fieldset: React.CSSProperties = {
  border: '1px solid #ddd',
  padding: 12,
  display: 'grid',
  gap: 8,
};
export const label: React.CSSProperties = { display: 'grid', gap: 4 };
export const errStyle: React.CSSProperties = {
  background: '#fee',
  color: '#900',
  padding: 12,
  whiteSpace: 'pre-wrap',
};
export const gridForm: React.CSSProperties = { display: 'grid', gap: 16, maxWidth: 820 };

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
}

export const emptyAddress = (): Address => ({
  name: '',
  line1: '',
  city: '',
  countryCode: 'US',
});

export function AddressBlock({
  legend,
  address,
  onChange,
}: {
  legend: string;
  address: Address;
  onChange: (a: Address) => void;
}): React.ReactElement {
  return (
    <fieldset style={fieldset}>
      <legend>{legend}</legend>
      <input
        placeholder="Name"
        value={address.name}
        onChange={(e) => onChange({ ...address, name: e.target.value })}
        required
      />
      <input
        placeholder="Address line 1"
        value={address.line1}
        onChange={(e) => onChange({ ...address, line1: e.target.value })}
        required
      />
      <input
        placeholder="City"
        value={address.city}
        onChange={(e) => onChange({ ...address, city: e.target.value })}
        required
      />
      <input
        placeholder="Country (2-letter ISO)"
        value={address.countryCode}
        onChange={(e) => onChange({ ...address, countryCode: e.target.value })}
        maxLength={2}
        required
      />
    </fieldset>
  );
}

/**
 * Trading-relationship descriptor as returned by GET /network/relationships.
 * Every create form filters to ACTIVE relationships that (a) place the
 * active org on the correct side (issuer role) and (b) have the doc type
 * enabled.
 */
export interface RelDescriptor {
  id: string;
  buyerOrgId: string;
  supplierOrgId: string;
  status: string;
  enabledDocumentTypes: string[];
}

export function useEligibleRelationships(
  activeOrgId: string | undefined,
  role: 'BUYER' | 'SUPPLIER',
  docType: string,
): RelDescriptor[] {
  const [rels, setRels] = useState<RelDescriptor[]>([]);
  useEffect(() => {
    if (!activeOrgId) return;
    void api<{ relationships: RelDescriptor[] }>('/network/relationships')
      .then((r) => {
        const valid = r.relationships.filter((rel) => {
          const ourSide = role === 'BUYER' ? rel.buyerOrgId : rel.supplierOrgId;
          return (
            ourSide === activeOrgId &&
            rel.status === 'ACTIVE' &&
            rel.enabledDocumentTypes.includes(docType)
          );
        });
        setRels(valid);
      })
      .catch(() => setRels([]));
  }, [activeOrgId, role, docType]);
  return rels;
}

/**
 * Document reference as used by the predecessor pickers.
 */
export interface DocRef {
  id: string;
  documentNumber: string;
  documentType: string;
  status: string;
}

/**
 * Load candidate predecessor documents for the current form (e.g. list
 * POs in ISSUED/ACKNOWLEDGED/IN_FULFILLMENT status when creating an ASN).
 * Uses GET /documents with the box that matches how the issuer sees the
 * predecessor doc:
 *   - Supplier issuing ASN → predecessor PO is in supplier's inbox
 *   - Buyer issuing GR    → predecessor ASN is in buyer's inbox
 *   - Supplier issuing Invoice PO_FLIP → predecessor PO is in inbox
 *   - Buyer issuing Remittance → predecessors (Invoices) in inbox
 *   - Supplier issuing Credit Memo → predecessor Invoice in outbox
 * We pass box='both' as a simple default; the caller can filter results
 * further by status.
 */
export function usePredecessorCandidates(
  documentType: string,
  filterStatuses?: string[],
): DocRef[] {
  const [items, setItems] = useState<DocRef[]>([]);
  useEffect(() => {
    void api<{ documents: DocRef[] }>(`/documents?box=both&documentType=${documentType}&limit=200`)
      .then((r) => {
        const rows = filterStatuses
          ? r.documents.filter((d) => filterStatuses.includes(d.status))
          : r.documents;
        setItems(rows);
      })
      .catch(() => setItems([]));
  }, [documentType, filterStatuses?.join(',')]);
  return items;
}
