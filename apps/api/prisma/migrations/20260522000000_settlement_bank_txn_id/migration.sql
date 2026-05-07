-- Slice AN — persist bankTxnId on settlement.
-- The remittance batch flow (Slice AL/AM) already collects the bank's
-- transaction reference from the operator's CSV, but the settlement
-- record dropped it on the floor. Add the column so finance can
-- reconcile a settlement back to the originating bank line item.
-- Nullable: pre-existing settlements have no bank reference, and
-- non-CSV receipt paths (manual recordReceipt) may legitimately omit it.

ALTER TABLE "settlement" ADD COLUMN "bankTxnId" TEXT;
