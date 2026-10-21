# Bingo ProMax Studio — puesta en operación

## 1. Configuración local

1. Copia `.env.example` como `.env`.
2. Configura `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` con los valores públicos del proyecto Supabase.
3. Configura `VITE_STUDIO_AUTH_REDIRECT_URL` con `https://bingopromaxstudio.pages.dev`.
4. Ejecuta `npm install` y después `npm run build`.

La clave debe ser la publishable/anon. Nunca coloques una `service_role` en este proyecto ni en variables `VITE_*`.

## 2. Base de datos y seguridad

En el SQL Editor de Supabase ejecuta, en este orden:

```text
supabase/001_studio.sql
```

Después ejecuta la segunda migración para activar la persistencia de checkpoints
remotos, triggers de `updated_at`, índices y validaciones de integridad:

```text
supabase/002_backend_hardening.sql
```

Finalmente ejecuta la migración de operación multiadministrador:

```text
supabase/003_multi_tenant_distribution.sql
supabase/004_sales_clients.sql
supabase/005_studio_controls_and_uniqueness.sql
supabase/006_admin_ball_control.sql
supabase/007_admin_block_control.sql
supabase/008_global_card_code_uniqueness.sql
```

Estas migraciones crean un espacio aislado por administrador, cuentas de
distribuidor y vendedor, clientes, ventas, titularidad de cada bloque,
transferencias auditables y el flujo protegido administrador → distribuidor →
vendedor. Solo los dos desarrolladores iniciales pueden crear administradores.

La migración crea inventario de bloques, partidas, patrones, auditoría, miembros y RLS. Las cuentas iniciales son:

- `byvera198@gmail.com`
- `bveraalvear@gmail.com`

La migración 005 deja preconfigurados `byvera980@gmail.com` como administrador y
`moavxy@gmail.com` como vendedor. También crea los controles para editar o
desactivar administradores, distribuidores y vendedores, encabezados propios,
marcas de agua por vendedor, selección de bloques por partida y una huella única
por cartón para impedir duplicados dentro de cada espacio administrativo.

La migración 006 reserva el registro de bolillas y las validaciones de ganadores
al administrador. La migración 007 impide eliminar bloques desde otros roles;
además, las transferencias o ventas existentes pueden impedir el borrado para
conservar la trazabilidad histórica. La migración 008 refuerza la unicidad del
código de cada cartón dentro del espacio administrativo.

En Authentication configura el proveedor Email, confirma las cuentas y agrega la URL de Studio a `Redirect URLs`:

```text
https://bingopromaxstudio.pages.dev
```

Conserva sin cambios la `Site URL` y las `Redirect URLs` que utiliza Bingo Control ProMax. Studio usa `emailRedirectTo` explícito para no redirigir nunca al dominio de ProMax.

## 3. Validación mínima antes de publicar

```powershell
npm run build
```

Después valida manualmente:

1. Solicitar enlace con cada cuenta desarrolladora.
2. Generar 100 hojas, descargar un PDF y un ZIP.
3. Confirmar 4 cartones por hoja, centro libre y numeración consecutiva.
4. Marcar un bloque como entregado y verificar que aparezca en auditoría.
5. Crear un administrador y confirmar que reciba su espacio independiente.
6. Crear un distribuidor y un vendedor dentro de ese espacio.
7. Transferir un bloque al distribuidor y después al vendedor; revisar el historial.
8. Crear una partida, seleccionar patrones, registrar bolillas y confirmar el ganador.
9. Exportar JSON v1.1 e importarlo en Bingo Control ProMax con una cuenta desarrolladora.

## 4. Publicación

Publica el contenido generado en `dist/` como sitio estático. En el proveedor elegido usa:

- Build command: `npm run build`
- Output directory: `dist`

Antes de publicar, comprueba que la URL final esté registrada en Supabase Auth. El repositorio contiene el código y la migración; la ejecución de la migración y la configuración de Auth son pasos administrativos del proyecto Supabase.

## 5. Escala de generación

La generación funciona en un Web Worker del navegador y guarda inventarios grandes en IndexedDB. Los lotes cercanos a 200.000 hojas se descargan por bloque para evitar construir un ZIP gigante en memoria. Si se requiere generación desatendida desde un servidor, la siguiente evolución puede mover el mismo motor a una cola de backend, conservando el formato JSON v1.1 y los códigos de bloque.

Cuando la segunda migración está instalada, cada checkpoint activo se replica en
`studio_generation_jobs`. Si Supabase no está disponible, Studio continúa con
IndexedDB y sincroniza el inventario cuando vuelve la conexión.
