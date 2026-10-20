# Checklist de producción — Bingo ProMax Studio

## Validación local obligatoria

```bash
npm ci
npm test
npm run build
npm run smoke
```

El resultado publicable es la carpeta `dist/`. La prueba `smoke` confirma que
el HTML contiene la aplicación y que el worker de generación de cartones quedó
incluido en los assets compilados.

## Configuración externa pendiente

1. Crear o seleccionar el proyecto Supabase de producción.
2. Ejecutar `supabase/001_studio.sql`, `supabase/002_backend_hardening.sql`, `supabase/003_multi_tenant_distribution.sql` y `supabase/004_sales_clients.sql` en ese orden.
3. Configurar en el hosting las variables de `.env.example` usando valores de
   producción. La clave publishable puede estar en el cliente; nunca usar una
   clave `service_role` en esta aplicación.
4. Configurar las Redirect URLs de Supabase para el dominio definitivo.
5. Publicar `dist/` con HTTPS y conservar una versión anterior para rollback.

## Aceptación después de publicar

- Iniciar sesión con `byvera198@gmail.com` y `bveraalvear@gmail.com`.
- Generar una prueba de 100 hojas, descargar PDF, ZIP, JSON y manifiesto.
- Crear un administrador, un distribuidor y un vendedor; confirmar un bloque de 40 hojas, registrar las dos transferencias y revisar su historial.
- Registrar clientes y ventas desde el distribuidor y el vendedor; confirmar que no se puedan vender más hojas/cartones de los disponibles.
- Ejecutar una generación grande y comprobar que el progreso permite reanudar.
- Revisar que la sesión, los bloques y el checkpoint sobrevivan a una recarga.
- Confirmar en Supabase que las políticas RLS y la auditoría están activas.

La ejecución de migraciones, la configuración del dominio y la publicación
real requieren acceso al proyecto Supabase/hosting; no se simulan localmente.
