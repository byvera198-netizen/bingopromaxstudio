-- Solo desarrolladores y administradores pueden eliminar inventario de bloques.
-- Ejecutar después de 006_admin_ball_control.sql.

create or replace function public.studio_assert_manager_block_delete()
returns trigger language plpgsql security definer set search_path = public
as $function$
begin
  if public.studio_actor_role() not in ('developer', 'admin') then
    raise exception 'Solo un administrador puede eliminar bloques';
  end if;
  return old;
end;
$function$;

drop trigger if exists studio_blocks_manager_delete on public.studio_blocks;
create trigger studio_blocks_manager_delete
before delete on public.studio_blocks
for each row execute function public.studio_assert_manager_block_delete();

