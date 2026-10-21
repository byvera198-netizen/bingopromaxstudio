-- Refuerzo de unicidad global por espacio administrativo.
-- Ejecutar después de 007_admin_block_control.sql.

create unique index if not exists studio_card_signatures_card_id_idx
  on public.studio_card_signatures(tenant_id, card_id)
  where card_id <> '';
