# Claudio: velocidad y seguimiento

## Objetivo
Ampliar el MCP local instalado en Claude Desktop y publicar su código en https://github.com/Shisetsu-Code/Claudio.

## Propuesta
Conservar Node.js, Playwright y las 12 herramientas existentes. Añadir un dashboard servido exclusivamente en 127.0.0.1, sin servicios externos ni cuentas nuevas.

### Velocidad
- Herramienta `set_speed` para seleccionar 1×, 2× o 4× y volver a velocidad normal.
- Acelerar el reloj de animaciones y temporizadores del contenido compatible, incluyendo los frames del juego.
- Mantener el tiempo real del MCP y del dashboard: un minuto transcurrido seguirá siendo un minuto.
- Reducir las esperas de observación en modo rápido, conservando la detección de movimiento y estabilidad.
- Mostrar el multiplicador solicitado y advertir de compatibilidad limitada: no acelera respuestas de red ni garantiza una mejora proporcional en todos los motores.

### Dashboard
- Estado: inactivo, cargando, observando, ejecutando tiradas, detenido por anomalía, cerrado o error.
- Juego/URL, inicio, tiempo transcurrido, última actividad y velocidad seleccionada.
- Lote actual: objetivo, completadas, pendientes, porcentaje y motivo de detención.
- Totales de sesión, tiempo medio por tirada y cronología de eventos.
- Descubrimientos registrados mediante `record_finding`: título, detalle, categoría y momento. Separar estas notas de los cambios visuales detectados automáticamente.
- Actualización continua durante `spin_loop`, sin esperar a la respuesta final de la herramienta.
- Guardar historial local; excluirlo de Git junto con capturas, perfiles personales y registros de red.
- Herramientas para consultar el estado y obtener la dirección del dashboard.

### Integración y publicación
Trabajar sobre una copia controlada de los archivos originales. Probar la conexión MCP, el navegador, la velocidad sobre una página de prueba determinista y el dashboard con progreso durante una ejecución. Instalar los archivos verificados en la carpeta Claudio conservando respaldo. Publicar código, instrucciones, pruebas y archivo de dependencias; nunca node_modules ni datos de sesiones.

## Alternativas
1. Dashboard local integrado (recomendación): sin despliegue, comparte estado con el MCP y funciona con Claude Desktop.
2. Dashboard hospedado: permite acceso remoto, pero requiere autenticación, almacenamiento y un enlace con la PC. Fuera de la petición actual.
3. Solo resúmenes MCP: más simple, pero no ofrece seguimiento mientras una herramienta está ejecutándose.

## Decisiones propuestas por el implementador
Dashboard local integrado, velocidad normal por defecto, controles explícitos de aceleración, pruebas locales reproducibles y documentación de límites por motor. No interpretar un cambio visual como una victoria o un bonus confirmado sin una nota de Claude.
