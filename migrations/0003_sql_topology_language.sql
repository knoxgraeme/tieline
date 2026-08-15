-- Allow complete hosted topology generations to persist SQL source facts.

alter table code_topology_files
  drop constraint code_topology_files_language_check,
  add constraint code_topology_files_language_check
    check (language in ('javascript', 'jsx', 'typescript', 'tsx', 'python', 'rust', 'sql'));
