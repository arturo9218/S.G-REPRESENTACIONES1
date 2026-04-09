# Manual de uso — AR Monitoreo

Guía para **usuarios y técnicos** que operan el panel web. No incluye detalles de programación ni de infraestructura.

---

## 1. Para qué sirve esta aplicación

**AR Monitoreo** es un panel en internet para **seguir equipos en frío** (cámaras, exhibidores, bodegas, etc.) y, cuando el hardware lo permite, **corriente eléctrica** en el tablero.

En la práctica permite:

- Ver **si el equipo está en línea** y **cuándo** fue la última lectura.
- Ver **una o dos temperaturas** por equipo (según sensores instalados).
- Ver **corriente** y una **estimación de potencia** si hay pinza amperométrica o datos de potencia.
- Consultar **gráficos** de evolución en el tiempo.
- Recibir **avisos** cuando la temperatura o la corriente salen de rango, o cuando el equipo **deja de mandar datos**.
- Guardar un **historial de alarmas** cuando la cuenta está vinculada a la nube.

Sirve para **control remoto**, **registro** y **respuesta rápida** ante fallas o desvíos de temperatura.

---

## 2. Requisitos para usar el panel

- **Navegador actualizado** (Chrome, Edge, Firefox o Safari recientes).
- **Cuenta de usuario** (correo y contraseña) dada de alta en el sistema.
- **Conexión a internet** en el dispositivo desde el que consultás (PC, tablet o celular).
- Para **avisos aunque la app esté cerrada**, el sitio debe estar configurado para ello y el navegador debe permitir notificaciones (especialmente en celular).

El **equipo en campo** (por ejemplo un control con sensores) debe estar **configurado por el técnico** para enviar datos al servicio; eso no se hace desde este manual, pero sí se refleja acá como temperaturas y estado.

---

## 3. Cómo entrar y salir

1. Abrí la **URL** del panel que te indique el administrador.
2. Iniciá sesión con **correo** y **contraseña**.
3. Si olvidaste la contraseña, usá la opción de **recuperar contraseña** desde la pantalla de inicio de sesión.
4. Para **cerrar sesión**, usá la opción de salir en la barra superior (según el diseño actual del sitio).

---

## 4. Partes principales del panel

El menú lateral (o el menú móvil) suele agrupar:

| Sección | Uso típico |
|--------|------------|
| **Dashboard / Inicio** | Vista general: tarjetas de equipos, gráfico reciente, resumen. |
| **Dispositivos** | Listado y tarjetas por equipo; seleccionar un equipo para ver detalle y acciones. |
| **Alertas** | Alarmas activas e historial de eventos guardados en la nube (si está habilitado). |
| **Configuración** | Umbrales, nombres de sensores, corrección de lectura, notificaciones, consumo aproximado del día, etc. |

**Análisis / Gráfico** puede abrirse desde un enlace tipo “ver gráfico” en la tarjeta del equipo: permite **elegir rango de fechas**, **canal** (temperatura 1, 2 o corriente) y **exportar** a PDF en muchos casos.

---

## 5. Tarjetas de equipo (lo que ves en pantalla)

En cada tarjeta suele mostrarse:

- **Nombre** y **ubicación** del equipo.
- **Estado en línea / fuera de línea** según la última comunicación recibida.
- **Temperatura(es)** con la unidad en grados Celsius.
- Opcionalmente un bloque **“Pinza / corriente”** con amperaje, potencia estimada y tensión de referencia que configuraste.
- **Última hora** de actualización.
- Botones para **editar** o **eliminar** el equipo (según permisos).

Si tu cuenta es de **administrador de la plataforma**, puede aparecer información de la **cuenta dueña** del equipo; eso sirve para soporte y auditoría.

---

## 6. Umbrales y notificaciones

En **Configuración** (con un equipo seleccionado) podés definir, entre otras cosas:

- **Temperatura mínima y máxima** para disparar alertas.
- **Corriente máxima** si medís amperaje.
- **Tensión nominal** del tablero (por ejemplo 220 V o 380 V): sirve para estimar potencia cuando solo hay corriente o potencia parcial, y para el **consumo aproximado del día** en kilovatios-hora.
- **Tiempos de espera** entre avisos repetidos (para no spamear alertas).

Podés **activar o desactivar** las notificaciones por equipo.

**Avisos con la app cerrada** (navegador) requieren que actives la opción en ese navegador y que el sitio tenga habilitado el servicio; en celular a veces hace falta **instalar la app como acceso en inicio** (PWA) para recibir avisos de forma fiable.

---

## 7. Corrección de sensores

Si un sensor marca sistemáticamente de más o de menos, en **Configuración** puede existir una **corrección en grados** por sensor. Eso ajusta lo que se guarda y se muestra **a partir de las nuevas lecturas** que lleguen.

---

## 8. Consumo eléctrico aproximado “del día”

Si el servicio lo tiene activo, podés pedir un **cálculo aproximado del consumo desde la medianoche** hasta el momento actual. Depende de que existan lecturas con **potencia o corriente** en el historial y de la **tensión nominal** configurada. Es una **estimación**, no un medidor fiscal certificado.

---

## 9. Gráficos y exportación

- En **análisis / gráfico** podés cambiar **rango de fechas**, **estilo de curva** y **qué magnitud** mirar.
- Donde esté disponible, podés **exportar a PDF** el cuadro de valores y, a veces, una captura del gráfico.

---

## 10. Roles: usuario y administrador

- **Usuario normal**: ve y configura **sus propios** equipos.
- **Administrador de la aplicación** (según lo defina tu organización): puede ver **todos** los equipos y, donde esté permitido, gestionar la lista de correos administradores.

Si alguien fue agregado como administrador y no ve todo, el responsable del sistema debe verificar que su correo esté correctamente habilitado en el servicio (soporte interno).

---

## 11. Qué se puede implementar a futuro (ideas)

Esta sección describe **funcionalidades posibles**; no implica que todas estén disponibles hoy. Sirve para planificar mejoras con el proveedor o el técnico de campo.

### 11.1 Control de puerta abierta con interruptor magnético

**Idea:** colocar un **sensor de apertura** (par magnético: una parte en el marco y otra en la puerta). Cuando la puerta está abierta, el circuito cambia de estado.

**En el panel podría mostrarse:** “Puerta cerrada / abierta”, tiempo abierta, o alerta “puerta abierta demasiado tiempo”.

**En campo:** el equipo debería leer esa entrada **digital** y enviar el estado junto con el resto de datos (según acuerdo con quien mantenga el firmware).

### 11.2 Otras mejoras habituales en frío industrial

- **Humedad relativa** en cámara o vitrina.
- **Segunda o tercera zona** de temperatura en el mismo equipo.
- **Presiones** de succión / descarga en instalaciones con frío mecánico.
- **Horarios de funcionamiento** y reportes de **desconexiones** programadas.
- **Informes mensuales** automáticos (PDF o correo) con mínimos, máximos y incidentes.
- **Etiquetas y turnos** (mañana/noche) para plantas con varios operadores.
- **Integración** con otros sistemas (por ejemplo ERP) solo a nivel de **exportación** o **API**, según política de la empresa.

### 11.3 Buenas prácticas operativas

- Revisar periódicamente que los **umbrales** reflejen la **temperatura segura** del producto almacenado.
- Mantener **nombres claros** de equipos y ubicaciones.
- Capacitar al personal en **reconocer alertas** y en **no ignorar** avisos repetidos de “fuera de línea”.

---

## 12. Soporte

Ante **fallas de visualización**, **datos que no llegan** o **dudas de permisos**, contactá al **administrador del sistema** o al **proveedor** que instaló el monitoreo, indicando: equipo afectado, horario aproximado del problema y captura de pantalla si es posible.

---

*Documento orientado al uso del producto. Las pantallas exactas pueden variar ligeramente según la versión desplegada.*
