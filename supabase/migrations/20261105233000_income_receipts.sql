-- Income can carry a document too (an invoice/receipt the business issued, or a payment confirmation),
-- uploaded from the web app's "upload a document" flow. Same private "receipts" bucket as expenses.
alter table income add column if not exists receipt_path text;
alter table income add column if not exists reference text; -- invoice / receipt number (אסמכתה)
