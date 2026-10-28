# Roadmap

## Shipped in this release (API)

Multi-tenant SaaS core, two packages and Paystack billing, GreenRev SSO, inventory (vehicles + parts), import landed cost with FX, full double-entry accounting (AR, AP, discounts, installments, VAT, FX gain/loss, P&L, balance sheet, cash flow, trial balance, aging, ledger), mechanics job cards, haulage trips, rentals, marketplace sync outbox + lead webhooks, and Claude-powered VIN scan, photo intake, listing writer, receipt reader and part identification.

## Next

1. **Web and mobile screens** in the existing GreenRev apps, using the OpenAPI client (see INTEGRATION.md §4).
2. **Branded PDF invoices and receipts**, with share-to-WhatsApp, using the org logo and TIN/RC number.
3. **Production storage**: S3/Cloudinary, with a private bucket for documents and signed URLs.
4. **Notifications**: installment reminders and overdue alerts by SMS/WhatsApp (Termii or the WhatsApp Business API), and low-stock alerts.
5. **Bank feeds and reconciliation**: Mono/Okra statement import, with matching against receipts and payments.
6. **Credit notes and returns** (partial refunds after payment), and **multi-branch** P&L by `branch`.
7. **FIRS e-invoicing (MBS)** submission once the business is onboarded, plus a WHT on supplier payments.
8. **Depreciation schedules** for fleet and rental cars, and a fixed-asset register.
9. **AI pricing insight**: suggest an asking price from the business's own sales history and marketplace comparables.
10. **API keys and webhooks out** for Pro (`api_access` feature), so dealers can connect their own sites.
