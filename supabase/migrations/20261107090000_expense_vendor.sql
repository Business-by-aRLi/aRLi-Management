-- Who the money went to (ספק), next to what it was for (description).
alter table expenses add column if not exists vendor text;
create index if not exists expenses_vendor_idx on expenses (vendor) where vendor is not null;
