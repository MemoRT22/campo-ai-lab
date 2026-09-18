# Briefing para Claude Code en el equipo de la instalación

Una sesión nueva de Claude Code en ese equipo no sabe nada del proyecto ni de lo que ya se probó.
Este es el primer mensaje que hay que pegarle para ponerla al día de golpe.

Se corre desde la carpeta del repo:

```bash
cd ~/campo-ai-lab && git pull && claude
```

Y se pega esto como primer mensaje:

```text
Instalación de visión artificial en una pared LED de una universidad. Repo campo-ai-lab,
rama codex/vision-hardening-pose. Presentamos mañana: no refactorices nada, sólo medir y
ajustar configuración por URL.

Equipo: Ubuntu, RTX 2070 Super, 16 GB. Webcam USB. La salida es una silueta de partículas
en la pared.

Problema abierto: la silueta no sale limpia ni detallada. El techo es el modelo, que
resuelve la escena en 256x144. Hay tres segmentadores en public/models y se cambian con
?vision.modelPath=... sin recompilar. Lee PRUEBAS.md, que tiene todas las URLs y una tabla
de síntoma -> parámetro.

Lo que necesito: levanta el servidor con npm run dev, ayúdame a comparar los tres modelos
y déjame los valores que mejor salgan. Yo me paro frente a la cámara y te digo qué veo:
tú no puedes ver la pared.
```

Si el evento ya pasó, cambia el segundo renglón por el objetivo que toque; lo demás sigue valiendo.

---

## Qué sí puede hacer esa sesión

- Levantar el servidor, leer el repo, correr los tests.
- Aplicar y revertir cambios de configuración al instante, sin copiar URLs a mano.
- Medir: leer números, comparar combinaciones, dejar anotado cuál ganó.
- Fijar en `src/config.ts` o en el perfil LARGE (`src/core/configOverrides.ts`) los valores que se
  decidan, cuando ya estén claros.

## Qué no

- **Ver la pared.** No puede juzgar si una silueta se ve bien.
- **Pararse frente a la cámara.** Hace falta una persona real a la distancia real.

Conviene decírselo tal cual desde el principio: tú eres los ojos, él ejecuta y mide.

## Dos avisos

El navegador lo abre la persona, no la sesión: el permiso de cámara necesita una ventana real en
esa pantalla.

Y en vísperas de un evento, lo único que debería tocar es configuración y el servidor de
desarrollo. Nada de reescribir código.
