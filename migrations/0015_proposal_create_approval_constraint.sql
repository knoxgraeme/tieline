-- An approved create proposal gains story_id atomically with creation. The
-- original shape constraint only allowed story_id NULL for create proposals,
-- making that valid terminal transition impossible.
alter table story_change_proposals drop constraint if exists story_change_proposals_check;
alter table story_change_proposals
  add constraint story_change_proposals_shape_check check (
    (
      operation = 'create'
      and base_revision_number is null
      and proposed_story_key is not null
      and (
        (status = 'approved' and story_id is not null)
        or (status <> 'approved' and story_id is null)
      )
    )
    or
    (operation <> 'create' and story_id is not null and base_revision_number is not null)
  );
