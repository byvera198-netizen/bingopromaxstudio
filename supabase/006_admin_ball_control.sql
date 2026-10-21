-- Solo los administradores pueden registrar bolillas y las validaciones resultantes.
-- Ejecutar después de 005_studio_controls_and_uniqueness.sql.

create or replace function public.studio_assert_admin_ball_control()
returns trigger language plpgsql security definer set search_path = public
as $function$
begin
  if (
    old.drawn_numbers is distinct from new.drawn_numbers
    or old.winner_history is distinct from new.winner_history
  ) and public.studio_actor_role() <> 'admin' then
    raise exception 'Solo un administrador puede registrar bolillas y validar ganadores';
  end if;
  return new;
end;
$function$;

drop trigger if exists studio_games_admin_ball_control on public.studio_games;
create trigger studio_games_admin_ball_control
before update of drawn_numbers, winner_history on public.studio_games
for each row execute function public.studio_assert_admin_ball_control();

