-- Optimistic concurrency for complete primary/secondary link replacement.
alter table feature_requests
  add column if not exists link_revision int not null default 1;

do $$ begin
  alter table feature_requests
    add constraint feature_requests_link_revision_positive check (link_revision > 0);
exception when duplicate_object then null;
end $$;
