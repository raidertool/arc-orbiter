const canvas = document.querySelector("#viewport");
const axisCanvas = document.querySelector("#axis-gizmo");
const telemetryEl = document.querySelector("#telemetry");
const statusEl = document.querySelector("#status");
const lockButton = document.querySelector("#lock");
const xrayToggle = document.querySelector("#xray");
const speedInput = document.querySelector("#speed");
const speedDownButton = document.querySelector("#speed-down");
const speedUpButton = document.querySelector("#speed-up");
const speedValue = document.querySelector("#speed-value");
const scaleInput = document.querySelector("#scale");
const scaleValue = document.querySelector("#scale-value");
const gl = canvas.getContext("webgl2", { antialias: false });
const axisContext = axisCanvas?.getContext("2d") || null;

const DEFAULT_MANIFEST = "../../.tmp/stella-montis/root-meshes/manifest.json";
const manifestScript = document.querySelector("script[data-default-manifest]");
const defaultManifest = window.STELLA_MONTIS_MANIFEST ?? manifestScript?.dataset.defaultManifest ?? DEFAULT_MANIFEST;
const query = new URLSearchParams(window.location.search);
const manifestHref = query.get("manifest") || defaultManifest;
const residentBudget = parseBudget(query.get("budget"), 420);
const streamRadius = parseRadius(query.get("radius"), 18);
const userPositionScale = parsePositionScale(query.get("flip") || "x");
const settings = {
  showBackdrop: true,
  speed: parseSpeed(query.get("speed"), 0.5),
  scale: parseScale(query.get("scale"), 1),
  xray: parseBool(query.get("xray"), false),
};
const OBJ_LOAD_BATCH_SIZE = 12;
const PACKED_LOAD_BATCH_SIZE = 96;
const OBJ_MAX_CONCURRENT_LOADS = 2;
const PACKED_MAX_CONCURRENT_LOADS = 18;
const STREAM_INTERVAL_MS = 80;
const HUD_UPDATE_INTERVAL_MS = 250;
const TELEMETRY_LOG_INTERVAL_MS = 2000;
const SPEED_STEP = 0.1;
const SHIFT_SPEED_MULTIPLIER = 5;
const VIEWER_COORDINATE_SYSTEM = "unreal-x-z-neg-y";
const DEFAULT_CAMERA = window.STELLA_MONTIS_CAMERA || {
  position: [10658.9, 4156.1, 4330.3],
  heading: 1.8,
  pitch: -6.3,
};

const keys = new Set();
let yaw = 0;
let pitch = -0.18;
let lastFrame = performance.now();
let lastTelemetryLogAt = 0;
let lastTelemetryKey = "";
let scene = null;
let camera = {
  position: [0, 1.4, 8],
  speed: settings.speed,
  effectiveSpeed: settings.speed,
  lookDistance: 12,
};

initControls();

if (!manifestHref) {
  setStatus("Data endpoint is not configured.");
} else if (!gl) {
  setStatus("WebGL2 is not available in this browser.");
} else {
  queueMicrotask(() => boot().catch((error) => {
    console.error(error);
    setStatus(`Failed: ${error.message}`);
  }));
}

lockButton.addEventListener("click", () => canvas.requestPointerLock());
canvas.addEventListener("click", () => canvas.requestPointerLock());

document.addEventListener("pointerlockchange", () => {
  lockButton.textContent = document.pointerLockElement === canvas ? "Mouse captured" : "Enter flythrough";
});

document.addEventListener("mousemove", (event) => {
  if (document.pointerLockElement !== canvas) return;
  yaw += event.movementX * 0.002;
  pitch -= event.movementY * 0.002;
  pitch = clamp(pitch, -1.48, 1.48);
});

window.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "Escape") document.exitPointerLock();
  if (event.code === "Minus" || event.code === "BracketLeft") {
    adjustSpeed(-SPEED_STEP);
    event.preventDefault();
  }
  if (event.code === "Equal" || event.code === "BracketRight") {
    adjustSpeed(SPEED_STEP);
    event.preventDefault();
  }
  if (event.code === "KeyX") {
    settings.xray = !settings.xray;
    if (xrayToggle) xrayToggle.checked = settings.xray;
    if (scene) setStatus(makeStats());
  }
  if (event.code === "KeyC" && scene) {
    void copyTelemetrySnapshot(performance.now());
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("resize", resizeCanvas);

function initControls() {
  if (xrayToggle) {
    xrayToggle.checked = settings.xray;
    xrayToggle.addEventListener("change", () => {
      settings.xray = xrayToggle.checked;
      if (scene) setStatus(makeStats());
    });
  }

  if (speedInput) {
    speedInput.value = String(settings.speed);
    speedInput.addEventListener("input", () => {
      settings.speed = parseSpeed(speedInput.value, settings.speed);
      camera.speed = settings.speed;
      updateMovementSpeed();
      updateSpeedLabel();
    });
  }
  if (scaleInput) {
    scaleInput.value = String(settings.scale);
    scaleInput.addEventListener("input", () => {
      settings.scale = parseScale(scaleInput.value, settings.scale);
      applySceneScale(true);
      updateScaleLabel();
    });
  }
  speedDownButton?.addEventListener("click", () => adjustSpeed(-SPEED_STEP));
  speedUpButton?.addEventListener("click", () => adjustSpeed(SPEED_STEP));
  updateSpeedLabel();
  updateScaleLabel();
}

function adjustSpeed(delta) {
  settings.speed = parseSpeed(settings.speed + delta, settings.speed);
  camera.speed = settings.speed;
  if (speedInput) speedInput.value = String(settings.speed);
  updateMovementSpeed();
  updateSpeedLabel();
}

function updateSpeedLabel() {
  if (!speedValue) return;
  speedValue.value = formatSpeed(settings.speed);
}

function updateScaleLabel() {
  if (!scaleValue) return;
  scaleValue.value = `${formatScale(settings.scale)}x`;
}

async function boot() {
  resizeCanvas();
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.018, 0.022, 0.028, 1);

  const program = createProgram(VERTEX_SOURCE, FRAGMENT_SOURCE);
  scene = {
    program,
    uniforms: {
      projection: gl.getUniformLocation(program, "uProjection"),
      view: gl.getUniformLocation(program, "uView"),
      center: gl.getUniformLocation(program, "uCenter"),
      scale: gl.getUniformLocation(program, "uScale"),
      positionScale: gl.getUniformLocation(program, "uPositionScale"),
      light: gl.getUniformLocation(program, "uLight"),
      opacity: gl.getUniformLocation(program, "uOpacity"),
    },
    chunks: [],
    entries: [],
    format: "obj",
    compression: null,
    positionScale: [1, 1, 1],
    preferSpatialStreaming: false,
    manifestUrl: null,
    bounds: createBounds(),
    baseScale: 1,
    baseRadius: 1,
    scale: 1,
    radius: 1,
    vertexCount: 0,
    indexCount: 0,
    meshCount: 0,
    totalMeshCount: 0,
    visibleMeshCount: 0,
    hiddenBackdropCount: 0,
    failedCount: 0,
    loadingCount: 0,
    loadedEverCount: 0,
    drawnMeshCount: 0,
    drawnVertexCount: 0,
    drawnIndexCount: 0,
    pendingCandidateCount: 0,
    lastStreamAt: 0,
    lastHudAt: 0,
    residentBudget,
    streamRadius,
  };

  await loadManifest(manifestHref);
  placeCamera();
  applyCameraQueryOverride();
  scheduleStreaming(true);
  requestAnimationFrame(frame);
}

async function loadManifest(href) {
  const manifestUrl = new URL(href, window.location.href);
  scene.manifestUrl = manifestUrl;
  setStatus(`Indexing ${manifestUrl.pathname}...`);

  const manifest = await loadManifestIndex(manifestUrl);
  if (manifest.format === "stella-packed-scene-v1" && Array.isArray(manifest.chunks)) {
    scene.format = "packed";
    scene.compression = manifest.compression || null;
    scene.positionScale = packedPositionScale(manifest);
    scene.preferSpatialStreaming = true;
    scene.entries = manifest.chunks
      .map((chunk, index) => makePackedEntry(chunk, index, manifestUrl))
      .filter(Boolean);
    if (scene.entries.length === 0) throw new Error("packed manifest contains no chunks");
  } else {
    scene.format = "obj";
    scene.positionScale = [1, 1, 1];
    scene.preferSpatialStreaming = false;
    const meshes = normalizeManifest(manifest);
    if (meshes.length === 0) throw new Error("manifest contains no meshes");
    scene.entries = meshes
      .map((mesh, index) => makeSceneEntry(mesh, index, manifestUrl))
      .filter(Boolean);
  }
  scene.totalMeshCount = scene.entries.length;

  applyEntryVisibility(false);
  if (!hasFiniteBounds(scene.bounds)) throw new Error("manifest contains no usable mesh positions");
  setStatus(makeStats());
}

async function loadManifestIndex(manifestUrl) {
  const manifest = await fetchJson(manifestUrl);
  if (manifest.format !== "stella-packed-scene-v1" || !Array.isArray(manifest.chunkParts)) {
    return manifest;
  }

  const chunks = [];
  for (let index = 0; index < manifest.chunkParts.length; index += 1) {
    setStatus(`Indexing ${manifestUrl.pathname} ${index + 1}/${manifest.chunkParts.length}...`);
    const partUrl = new URL(manifest.chunkParts[index], manifestUrl);
    const part = await fetchJson(partUrl);
    if (Array.isArray(part)) {
      chunks.push(...part);
    } else if (Array.isArray(part.chunks)) {
      chunks.push(...part.chunks);
    } else {
      throw new Error(`manifest shard has no chunks: ${partUrl.pathname}`);
    }
  }
  return {
    ...manifest,
    chunks,
  };
}

function normalizeManifest(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest.meshes)) return manifest.meshes;
  if (Array.isArray(manifest.objects)) return manifest.objects;
  if (Array.isArray(manifest.exports)) return manifest.exports;
  return [];
}

function makeSceneEntry(mesh, index, manifestUrl) {
  const file = mesh.file || mesh.path || mesh.obj || "";
  if (!file) return null;
  const translation = mesh.transform && Array.isArray(mesh.transform.translation)
    ? mesh.transform.translation
    : [0, 0, 0];
  const center = mesh.parentTransform
    ? transformUnrealPoint(translation, mesh.parentTransform)
    : translation;

  return {
    index,
    mesh,
    category: isBackdropMesh(mesh) ? "backdrop" : "level",
    visible: true,
    url: new URL(file, manifestUrl),
    center: unrealToViewerPoint(center),
    state: "pending",
    chunk: null,
  };
}

function makePackedEntry(chunk, index, manifestUrl) {
  const file = chunk.file || chunk.path || "";
  if (!file) return null;
  const bounds = transformPackedBounds(chunk.bounds);
  const center = transformPackedPoint(chunk.center) || (bounds ? boundsCenter(bounds) : null);
  if (!center) return null;

  return {
    index,
    mesh: chunk,
    category: chunk.category || "level",
    visible: true,
    url: new URL(file, manifestUrl),
    center,
    bounds,
    objects: packedProbeObjects(chunk),
    state: "pending",
    chunk: null,
    binary: true,
    compression: chunk.compression || null,
  };
}

function packedProbeObjects(chunk) {
  if (!Array.isArray(chunk.objects)) return [];
  return chunk.objects
    .map((object) => {
      const bounds = transformPackedBounds(object.bounds);
      const center = transformPackedPoint(object.center) || (bounds ? boundsCenter(bounds) : null);
      if (!center) return null;
      return {
        ...object,
        center,
        bounds,
        radius: boundsRadius(bounds),
      };
    })
    .filter(Boolean);
}

function isBackdropMesh(mesh) {
  const haystack = [
    mesh.name,
    mesh.sourceMesh,
    mesh.sourcePackage,
    mesh.component,
    mesh.componentType,
    mesh.file,
  ].filter(Boolean).join(" ").toLowerCase();

  return haystack.includes("/backdrop/") ||
    haystack.includes("sm_mcp_backdrop") ||
    haystack.includes("sm_staticcloudssphere") ||
    haystack.includes("/volumeclouds/") ||
    haystack.includes("/environment/north/") ||
    haystack.includes("/environment/south/") ||
    haystack.includes("/environment/nature/") ||
    haystack.includes("volcanicred") ||
    haystack.includes("cliff_xl") ||
    haystack.includes("rock_xl") ||
    haystack.includes("ledge_xl") ||
    haystack.includes("skysphere") ||
    haystack.includes("sky_sphere");
}

function applyEntryVisibility(resetCamera) {
  scene.visibleMeshCount = 0;
  scene.hiddenBackdropCount = 0;

  for (const entry of scene.entries) {
    entry.visible = !isHiddenSceneryCategory(entry.category) || settings.showBackdrop;
    if (entry.visible) {
      scene.visibleMeshCount += 1;
    } else {
      scene.hiddenBackdropCount += 1;
      if (entry.chunk) disposeChunk(entry.chunk);
    }
  }

  rebuildSceneBounds();
  if (resetCamera) {
    placeCamera();
    scheduleStreaming(true);
  }
  setStatus(makeStats());
}

function isHiddenSceneryCategory(category) {
  return category === "backdrop" || category === "scenery";
}

function rebuildSceneBounds() {
  const visible = scene.entries.filter((entry) => entry.visible);
  const levelEntries = visible.filter((entry) => !isHiddenSceneryCategory(entry.category));
  const points = (levelEntries.length ? levelEntries : visible).map((entry) => entry.center);
  const trim = scene.format === "packed" ? 0.05 : 0.01;
  scene.bounds = points.length > 24 ? makeTrimmedBounds(points, trim, 1 - trim) : makePointBounds(points);
}

function addMesh(parsed, entry) {
  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const indexBuffer = parsed.indices ? gl.createBuffer() : null;
  const positionLoc = gl.getAttribLocation(scene.program, "aPosition");

  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, 0, 0);

  if (indexBuffer) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, parsed.indices, gl.STATIC_DRAW);
  }

  gl.bindVertexArray(null);

  const vertexCount = parsed.positions.length / 3;
  const indexCount = parsed.indices ? parsed.indices.length : vertexCount;
  const chunk = {
    vao,
    positionBuffer,
    indexBuffer,
    count: indexCount,
    vertexCount,
    indexCount,
    entryIndex: entry.index,
    center: entry.center,
    bounds: parsed.bounds || entry.bounds || null,
    objects: entry.objects || [],
    radius: boundsRadius(parsed.bounds || entry.bounds),
  };
  scene.chunks.push(chunk);
  scene.meshCount += 1;
  scene.loadedEverCount += 1;
  scene.vertexCount += chunk.vertexCount;
  scene.indexCount += chunk.indexCount;
  return chunk;
}

function parseObj(text, parentTransform = null) {
  const vertices = [[0, 0, 0]];
  const positions = [];
  const bounds = createBounds();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line[0] === "#") continue;

    const parts = line.split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      const point = parentTransform ? transformUnrealPoint([x, y, z], parentTransform) : [x, y, z];
      vertices.push(unrealToViewerPoint(point));
    } else if (parts[0] === "f" && parts.length >= 4) {
      const face = parts.slice(1).map((token) => parseObjIndex(token, vertices.length));
      for (let i = 1; i < face.length - 1; i += 1) {
        pushTriangle(vertices[face[0]], vertices[face[i]], vertices[face[i + 1]], positions, bounds);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    bounds,
  };
}

function parsePackedChunk(buffer, bounds) {
  if (buffer.byteLength < 16) throw new Error("packed chunk is too small");
  const magic = Array.from(new Uint8Array(buffer, 0, 8), (value) => String.fromCharCode(value)).join("");
  if (magic !== "STLBIN1\0") throw new Error("packed chunk has an unknown header");

  const view = new DataView(buffer);
  const vertexCount = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  const positionOffset = 16;
  const positionBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  const indexOffset = positionOffset + positionBytes;
  const indexBytes = indexCount * Uint32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength < indexOffset + indexBytes) {
    throw new Error("packed chunk is truncated");
  }

  return {
    positions: new Float32Array(buffer, positionOffset, vertexCount * 3),
    indices: new Uint32Array(buffer, indexOffset, indexCount),
    bounds: bounds || boundsFromPositions(new Float32Array(buffer, positionOffset, vertexCount * 3)),
  };
}

function parseObjIndex(token, vertexCount) {
  const value = Number(token.split("/")[0]);
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? vertexCount + value : value;
}

function pushTriangle(a, b, c, positions, bounds) {
  if (!a || !b || !c) return;

  for (const point of [a, b, c]) {
    positions.push(point[0], point[1], point[2]);
    includePoint(bounds, point);
  }
}

function placeCamera() {
  const center = boundsCenter(scene.bounds);
  const size = boundsSize(scene.bounds);
  const maxSize = Math.max(size[0], size[1], size[2], 1);
  scene.center = center;
  scene.baseScale = 36 / maxSize;
  scene.baseRadius = maxSize * scene.baseScale * 0.5;
  applySceneScale(false);
  const defaultPosition = Array.isArray(DEFAULT_CAMERA.position) && DEFAULT_CAMERA.position.length >= 3
    ? DEFAULT_CAMERA.position
    : null;
  if (defaultPosition) {
    camera.position = [
      (defaultPosition[0] - scene.center[0]) * scene.scale,
      (defaultPosition[1] - scene.center[1]) * scene.scale,
      (defaultPosition[2] - scene.center[2]) * scene.scale,
    ];
  } else {
    const height = Math.max(4, scene.radius * 0.45);
    const distance = Math.max(4, scene.radius * 0.38);
    camera.position = [0, height, distance];
  }
  yaw = degreesToRadians(Number.isFinite(DEFAULT_CAMERA.heading) ? DEFAULT_CAMERA.heading : 0);
  pitch = clamp(
    degreesToRadians(Number.isFinite(DEFAULT_CAMERA.pitch) ? DEFAULT_CAMERA.pitch : -20),
    -1.48,
    1.48,
  );
  camera.speed = settings.speed;
  updateMovementSpeed();
}

function applyCameraQueryOverride() {
  const mapPosition = readQueryPoint(["x", "y", "z"]);
  if (mapPosition) {
    camera.position = [
      (mapPosition[0] - scene.center[0]) * scene.scale,
      (mapPosition[1] - scene.center[1]) * scene.scale,
      (mapPosition[2] - scene.center[2]) * scene.scale,
    ];
  }

  const heading = parseOptionalNumber(query.get("heading"));
  if (heading != null) yaw = degreesToRadians(heading);
  const queryPitch = parseOptionalNumber(query.get("pitch"));
  if (queryPitch != null) pitch = clamp(degreesToRadians(queryPitch), -1.48, 1.48);
}

function readQueryPoint(names) {
  const values = names.map((name) => parseOptionalNumber(query.get(name)));
  return values.every((value) => value != null) ? values : null;
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  updateHud(now);
  updateCamera(dt);
  updateStreaming(now);
  draw();
  drawAxisGizmo();
  updateTelemetry(now);
  requestAnimationFrame(frame);
}

function updateStreaming(now) {
  if (now - scene.lastStreamAt < STREAM_INTERVAL_MS) return;
  scene.lastStreamAt = now;
  unloadDistantMeshes();
  scheduleStreaming(false);
}

function updateHud(now) {
  if (now - scene.lastHudAt < HUD_UPDATE_INTERVAL_MS) return;
  scene.lastHudAt = now;
  updateMovementSpeed();
  updateSpeedLabel();
}

function scheduleStreaming(initial) {
  const maxConcurrentLoads = scene.format === "packed" ? PACKED_MAX_CONCURRENT_LOADS : OBJ_MAX_CONCURRENT_LOADS;
  const loadBatchSize = scene.format === "packed" ? PACKED_LOAD_BATCH_SIZE : OBJ_LOAD_BATCH_SIZE;
  if (scene.loadingCount >= maxConcurrentLoads) return;
  if (Number.isFinite(scene.residentBudget) && scene.meshCount + scene.loadingCount >= scene.residentBudget) {
    freeBudgetForCloserPending(initial);
  }

  const openSlots = Math.max(0, maxConcurrentLoads - scene.loadingCount);
  const budgetCapacity = Number.isFinite(scene.residentBudget)
    ? Math.max(0, scene.residentBudget - scene.meshCount - scene.loadingCount)
    : Number.POSITIVE_INFINITY;
  const loadCount = Math.min(loadBatchSize, openSlots, budgetCapacity);
  if (loadCount <= 0) {
    setStatus(makeStats());
    return;
  }

  const pendingCandidates = getPendingCandidates(initial);
  scene.pendingCandidateCount = pendingCandidates.length;
  const candidates = pendingCandidates.slice(0, loadCount);

  if (candidates.length === 0) {
    setStatus(makeStats());
    return;
  }

  for (const candidate of candidates) {
    candidate.entry.state = "queued";
    void loadEntry(candidate.entry);
  }
  setStatus(makeStats());
}

function getPendingCandidates(initial) {
  const loadAll = scene.entries.length <= scene.residentBudget || !Number.isFinite(scene.streamRadius);
  return scene.entries
    .filter((entry) => entry.visible && entry.state === "pending")
    .map((entry) => ({ entry, distance: entryDistance(entry), score: entryLoadScore(entry) }))
    .filter((candidate) => loadAll || initial || candidate.distance <= scene.streamRadius)
    .sort((a, b) => a.score - b.score);
}

function freeBudgetForCloserPending(initial) {
  const loadBatchSize = scene.format === "packed" ? PACKED_LOAD_BATCH_SIZE : OBJ_LOAD_BATCH_SIZE;
  const pending = getPendingCandidates(initial).slice(0, loadBatchSize);
  if (pending.length === 0) return;

  const loaded = scene.chunks
    .map((chunk) => ({ chunk, distance: chunkDistance(chunk) }))
    .sort((a, b) => b.distance - a.distance);

  for (let i = 0; i < pending.length && i < loaded.length; i += 1) {
    if (pending[i].distance + 0.75 >= loaded[i].distance) break;
    disposeChunk(loaded[i].chunk);
  }
}

async function loadEntry(entry) {
  scene.loadingCount += 1;
  setStatus(makeStats());
  try {
    const parsed = entry.binary
      ? parsePackedChunk(await fetchPackedArrayBuffer(entry), entry.bounds)
      : parseObj(await fetchText(entry.url), entry.mesh.parentTransform);
    const drawCount = parsed.indices ? parsed.indices.length : parsed.positions.length / 3;
    if (parsed.positions.length === 0 || drawCount === 0) throw new Error("empty mesh");
    if (!entry.visible) {
      entry.state = "pending";
      return;
    }
    entry.chunk = addMesh(parsed, entry);
    entry.state = "loaded";
  } catch (error) {
    entry.state = "failed";
    scene.failedCount += 1;
    console.warn("Skipping mesh", entry.mesh, error);
  } finally {
    scene.loadingCount -= 1;
    draw();
    drawAxisGizmo();
    setStatus(makeStats());
    scheduleStreaming(false);
    await nextPaint();
  }
}

async function fetchPackedArrayBuffer(entry) {
  let buffer = await fetchArrayBuffer(entry.url);
  const compression = entry.compression || scene.compression;
  if (compression === "gzip" && !hasPackedMagic(buffer)) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("gzip scene chunks require DecompressionStream support");
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    buffer = await new Response(stream).arrayBuffer();
  }
  return buffer;
}

function hasPackedMagic(buffer) {
  if (buffer.byteLength < 8) return false;
  const bytes = new Uint8Array(buffer, 0, 8);
  return bytes[0] === 0x53 &&
    bytes[1] === 0x54 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x42 &&
    bytes[4] === 0x49 &&
    bytes[5] === 0x4e &&
    bytes[6] === 0x31 &&
    bytes[7] === 0x00;
}

function unloadDistantMeshes() {
  if (!Number.isFinite(scene.residentBudget)) return;
  if (scene.meshCount < scene.residentBudget) return;

  const unloadDistance = scene.streamRadius * 1.35;
  const removable = scene.chunks
    .map((chunk) => ({ chunk, distance: chunkDistance(chunk) }))
    .filter((candidate) => candidate.distance > unloadDistance)
    .sort((a, b) => b.distance - a.distance);

  const targetCount = Math.floor(scene.residentBudget * 0.85);
  for (const candidate of removable) {
    if (scene.meshCount <= targetCount) break;
    disposeChunk(candidate.chunk);
  }
}

function disposeChunk(chunk) {
  const chunkIndex = scene.chunks.indexOf(chunk);
  if (chunkIndex < 0) return;
  scene.chunks.splice(chunkIndex, 1);
  const entry = scene.entries[chunk.entryIndex];
  if (entry) {
    entry.state = "pending";
    entry.chunk = null;
  }
  gl.deleteBuffer(chunk.positionBuffer);
  if (chunk.indexBuffer) gl.deleteBuffer(chunk.indexBuffer);
  gl.deleteVertexArray(chunk.vao);
  scene.meshCount -= 1;
  scene.vertexCount -= chunk.vertexCount;
  scene.indexCount -= chunk.indexCount;
}

function updateCamera(dt) {
  const forward = getForward();
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = [0, 1, 0];
  const movement = [0, 0, 0];

  if (keys.has("KeyW")) addScaled(movement, forward, 1);
  if (keys.has("KeyS")) addScaled(movement, forward, -1);
  if (keys.has("KeyD")) addScaled(movement, right, 1);
  if (keys.has("KeyA")) addScaled(movement, right, -1);
  if (keys.has("KeyE")) addScaled(movement, up, 1);
  if (keys.has("KeyQ")) addScaled(movement, up, -1);

  const len = length(movement);
  if (len > 0) {
    const boost = keys.has("ShiftLeft") || keys.has("ShiftRight") ? SHIFT_SPEED_MULTIPLIER : 1;
    addScaled(camera.position, movement, (camera.effectiveSpeed * boost * dt) / len);
  }
}

function applySceneScale(updateStatus) {
  if (!scene) return;
  scene.scale = scene.baseScale * settings.scale;
  scene.radius = scene.baseRadius * settings.scale;
  if (updateStatus) setStatus(makeStats());
}

function updateMovementSpeed() {
  camera.speed = settings.speed;
  camera.effectiveSpeed = settings.speed;
}

function draw() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(scene.program);
  applyRenderMode();

  const aspect = canvas.width / Math.max(canvas.height, 1);
  const projection = perspective(Math.PI / 3, aspect, 0.02, Math.max(1000, scene.radius * 24));
  const forward = getForward();
  const view = lookFrom(camera.position, forward, [0, 1, 0]);

  gl.uniformMatrix4fv(scene.uniforms.projection, false, projection);
  gl.uniformMatrix4fv(scene.uniforms.view, false, view);
  gl.uniform3fv(scene.uniforms.center, scene.center);
  gl.uniform1f(scene.uniforms.scale, scene.scale);
  gl.uniform3fv(scene.uniforms.positionScale, scene.positionScale);
  gl.uniform3fv(scene.uniforms.light, normalize([0.4, 0.8, 0.35]));
  gl.uniform1f(scene.uniforms.opacity, settings.xray ? 0.22 : 1);

  scene.drawnMeshCount = 0;
  scene.drawnVertexCount = 0;
  scene.drawnIndexCount = 0;
  for (const chunk of scene.chunks) {
    if (!shouldDrawChunk(chunk, forward)) continue;
    gl.bindVertexArray(chunk.vao);
    if (chunk.indexBuffer) {
      gl.drawElements(gl.TRIANGLES, chunk.count, gl.UNSIGNED_INT, 0);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
    }
    scene.drawnMeshCount += 1;
    scene.drawnVertexCount += chunk.vertexCount;
    scene.drawnIndexCount += chunk.indexCount;
  }

  gl.bindVertexArray(null);
  if (settings.xray) gl.depthMask(true);
}

function applyRenderMode() {
  if (settings.xray) {
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    return;
  }

  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
}

function shouldDrawChunk(chunk, forward) {
  const center = normalizeScenePoint(chunk.center);
  const toCenter = subtract(center, camera.position);
  const distance = length(toCenter);
  if (!Number.isFinite(distance)) return false;
  const radius = chunk.radius * scene.scale;
  if (distance < Math.max(8, radius * 1.5)) return true;
  if (distance > scene.streamRadius * 1.6 + radius && distance > scene.radius * 1.1 + radius) return false;
  if (distance < 6) return true;
  const padding = Math.min(0.65, radius / Math.max(distance, 0.001));
  return dot(toCenter, forward) / distance > -0.2 - padding;
}

function getForward() {
  const cp = Math.cos(pitch);
  return normalize([
    Math.sin(yaw) * cp,
    Math.sin(pitch),
    -Math.cos(yaw) * cp,
  ]);
}

function drawAxisGizmo() {
  if (!axisContext || !axisCanvas) return;

  const width = axisCanvas.width;
  const height = axisCanvas.height;
  axisContext.clearRect(0, 0, width, height);
  axisContext.save();
  axisContext.scale(width / axisCanvas.clientWidth, height / axisCanvas.clientHeight);

  const size = axisCanvas.clientWidth;
  const origin = [size * 0.5, size * 0.54];
  const axisLength = size * 0.32;
  const forward = getForward();
  const cameraRight = normalize(cross(forward, [0, 1, 0]));
  const cameraUp = normalize(cross(cameraRight, forward));
  const axes = [
    { label: "X", color: "#ff5a5f", vector: [1, 0, 0] },
    { label: "Y", color: "#5ee079", vector: [0, 1, 0] },
    { label: "Z", color: "#5aa7ff", vector: [0, 0, 1] },
  ].map((axis) => ({
    ...axis,
    projected: projectAxisVector(axis.vector, cameraRight, cameraUp, axisLength),
    depth: dot(axis.vector, forward),
  })).sort((a, b) => a.depth - b.depth);

  axisContext.lineCap = "round";
  axisContext.lineJoin = "round";
  axisContext.font = "700 12px Inter, ui-sans-serif, system-ui, sans-serif";
  axisContext.textAlign = "center";
  axisContext.textBaseline = "middle";

  axisContext.strokeStyle = "rgba(255, 255, 255, 0.18)";
  axisContext.lineWidth = 1;
  axisContext.beginPath();
  axisContext.arc(origin[0], origin[1], size * 0.04, 0, Math.PI * 2);
  axisContext.stroke();

  for (const axis of axes) {
    drawAxisHalf(origin, [-axis.projected[0], -axis.projected[1]], axis.color, 0.34);
  }
  for (const axis of axes) {
    drawAxisHalf(origin, axis.projected, axis.color, 1);
    drawAxisLabel(origin, axis.projected, axis.label, axis.color);
  }

  axisContext.restore();
}

function projectAxisVector(vector, cameraRight, cameraUp, axisLength) {
  return [
    dot(vector, cameraRight) * axisLength,
    -dot(vector, cameraUp) * axisLength,
  ];
}

function drawAxisHalf(origin, projected, color, alpha) {
  axisContext.globalAlpha = alpha;
  axisContext.strokeStyle = color;
  axisContext.lineWidth = alpha >= 1 ? 3 : 2;
  axisContext.beginPath();
  axisContext.moveTo(origin[0], origin[1]);
  axisContext.lineTo(origin[0] + projected[0], origin[1] + projected[1]);
  axisContext.stroke();
  axisContext.globalAlpha = 1;
}

function drawAxisLabel(origin, projected, label, color) {
  const length = Math.hypot(projected[0], projected[1]) || 1;
  const x = origin[0] + projected[0] + (projected[0] / length) * 10;
  const y = origin[1] + projected[1] + (projected[1] / length) * 10;
  axisContext.fillStyle = "rgba(0, 0, 0, 0.72)";
  axisContext.beginPath();
  axisContext.arc(x, y, 10, 0, Math.PI * 2);
  axisContext.fill();
  axisContext.fillStyle = color;
  axisContext.fillText(label, x, y + 0.5);
}

function updateTelemetry(now) {
  if (!telemetryEl || !scene) return;
  const telemetry = getCameraTelemetry();
  const nearestChunks = nearestLoadedChunks(5);
  const aimedChunks = aimedLoadedChunks(5);
  const nearestObjects = nearestLoadedObjects(5);
  const aimedObjects = aimedLoadedObjects(5);
  telemetryEl.textContent = [
    `XYZ ${formatCoord(telemetry.position[0])}, ${formatCoord(telemetry.position[1])}, ${formatCoord(telemetry.position[2])}`,
    `Head ${formatDegrees(telemetry.heading)} Pitch ${formatSignedDegrees(telemetry.pitch)}`,
    `Aim ${formatProbeLine(aimedObjects[0] || aimedChunks[0])}`,
    `Near ${formatProbeLine(nearestObjects[0] || nearestChunks[0])}`,
  ].join("\n");
  telemetryEl.dataset.camera = JSON.stringify(telemetry);
  telemetryEl.dataset.aimedChunks = JSON.stringify(aimedChunks);
  telemetryEl.dataset.nearestChunks = JSON.stringify(nearestChunks);
  telemetryEl.dataset.aimedObjects = JSON.stringify(aimedObjects);
  telemetryEl.dataset.nearestObjects = JSON.stringify(nearestObjects);
  logCameraTelemetry(now, false, telemetry, nearestChunks, aimedChunks, nearestObjects, aimedObjects);
}

async function copyTelemetrySnapshot(now) {
  const telemetry = getCameraTelemetry();
  const aimedChunks = aimedLoadedChunks(8);
  const nearestChunks = nearestLoadedChunks(8);
  const aimedObjects = aimedLoadedObjects(12);
  const nearestObjects = nearestLoadedObjects(12);
  const snapshot = {
    camera: telemetry,
    aimedObjects,
    nearestObjects,
    aimedChunks,
    nearestChunks,
  };
  logCameraTelemetry(now, true, telemetry, nearestChunks, aimedChunks, nearestObjects, aimedObjects);

  const json = JSON.stringify(snapshot, null, 2);
  if (!navigator.clipboard?.writeText) {
    setStatus(`${makeStats()} Probe logged.`);
    return;
  }

  try {
    await navigator.clipboard.writeText(json);
    setStatus(`${makeStats()} Probe copied.`);
  } catch (error) {
    console.warn("Could not copy stella probe", error, snapshot);
    setStatus(`${makeStats()} Probe logged; clipboard blocked.`);
  }
}

function logCameraTelemetry(
  now,
  force,
  telemetry = getCameraTelemetry(),
  nearestChunks = nearestLoadedChunks(5),
  aimedChunks = aimedLoadedChunks(5),
  nearestObjects = nearestLoadedObjects(5),
  aimedObjects = aimedLoadedObjects(5),
) {
  const key = [
    Math.round(telemetry.position[0]),
    Math.round(telemetry.position[1]),
    Math.round(telemetry.position[2]),
    Math.round(telemetry.yaw),
    Math.round(telemetry.pitch),
  ].join(",");
  if (!force && (key === lastTelemetryKey || now - lastTelemetryLogAt < TELEMETRY_LOG_INTERVAL_MS)) return;
  lastTelemetryKey = key;
  lastTelemetryLogAt = now;
  console.log("stella_camera", {
    ...telemetry,
    aimedObjects,
    nearestObjects,
    aimedChunks,
    nearestChunks,
  });
}

function getCameraTelemetry() {
  const position = cameraMapPosition();
  return {
    position,
    yaw: radiansToDegrees(yaw),
    pitch: radiansToDegrees(pitch),
    roll: 0,
    heading: radiansToDegrees(Math.atan2(getForward()[0], -getForward()[2])),
    angleUnits: "degrees",
    speed: camera.effectiveSpeed,
    scale: settings.scale,
    xray: settings.xray,
  };
}

function cameraMapPosition() {
  if (!scene || !scene.center || !Number.isFinite(scene.scale) || scene.scale === 0) return [0, 0, 0];
  return [
    scene.center[0] + camera.position[0] / scene.scale,
    scene.center[1] + camera.position[1] / scene.scale,
    scene.center[2] + camera.position[2] / scene.scale,
  ];
}

function nearestLoadedChunks(count) {
  if (!scene?.chunks?.length) return [];
  return scene.chunks
    .map((chunk) => chunkProbePayload(chunk))
    .filter((chunk) => Number.isFinite(chunk.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count);
}

function aimedLoadedChunks(count) {
  if (!scene?.chunks?.length) return [];
  const forward = getForward();
  return scene.chunks
    .map((chunk) => {
      const center = normalizeScenePoint(chunk.center);
      const radius = Math.max(0.2, chunk.radius * scene.scale);
      const hitDistance = raySphereIntersection(camera.position, forward, center, radius);
      if (!Number.isFinite(hitDistance)) return null;
      return chunkProbePayload(chunk, { rayDistance: Number(formatCoord(hitDistance)) });
    })
    .filter(Boolean)
    .sort((a, b) => a.rayDistance - b.rayDistance)
    .slice(0, count);
}

function nearestLoadedObjects(count) {
  return loadedProbeObjects()
    .map(({ object, chunk }) => objectProbePayload(object, chunk))
    .filter((object) => Number.isFinite(object.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count);
}

function aimedLoadedObjects(count) {
  const forward = getForward();
  return loadedProbeObjects()
    .map(({ object, chunk }) => {
      const center = normalizeScenePoint(object.center);
      const radius = Math.max(0.05, object.radius * scene.scale);
      const hitDistance = raySphereIntersection(camera.position, forward, center, radius);
      if (!Number.isFinite(hitDistance)) return null;
      return objectProbePayload(object, chunk, { rayDistance: Number(formatCoord(hitDistance)) });
    })
    .filter(Boolean)
    .sort((a, b) => a.rayDistance - b.rayDistance)
    .slice(0, count);
}

function loadedProbeObjects() {
  if (!scene?.chunks?.length) return [];
  const objects = [];
  for (const chunk of scene.chunks) {
    for (const object of chunk.objects || []) {
      objects.push({ object, chunk });
    }
  }
  return objects;
}

function chunkProbePayload(chunk, extra = {}) {
  const entry = scene.entries[chunk.entryIndex];
  return {
    ...extra,
    distance: Number(formatCoord(chunkDistance(chunk))),
    file: entry?.mesh?.file || entry?.url?.pathname || "",
    category: entry?.category || "",
    triangles: Math.floor(chunk.indexCount / 3),
    sourcePackages: entry?.mesh?.sourcePackages || [],
    sourceMeshes: entry?.mesh?.sourceMeshes || [],
  };
}

function objectProbePayload(object, chunk, extra = {}) {
  const entry = scene.entries[chunk.entryIndex];
  return {
    ...extra,
    distance: Number(formatCoord(length(subtract(normalizeScenePoint(object.center), camera.position)))),
    file: object.file || entry?.mesh?.file || "",
    chunkFile: entry?.mesh?.file || entry?.url?.pathname || "",
    category: entry?.category || "",
    name: object.name || "",
    component: object.component || "",
    componentType: object.componentType || "",
    triangles: object.triangles || 0,
    sourcePackages: object.sourcePackage ? [{ name: object.sourcePackage, count: 1 }] : [],
    sourceMeshes: object.sourceMesh ? [{ name: object.sourceMesh, count: 1 }] : [],
  };
}

function formatProbeLine(chunk) {
  if (!chunk) return "--";
  const distance = chunk.distance;
  return `${formatCoord(distance)} ${shortProbeName(primaryProbeName(chunk))}`;
}

function primaryProbeName(chunk) {
  return chunk.name || chunk.sourceMeshes?.[0]?.name || chunk.sourcePackages?.[0]?.name || chunk.file || "unknown";
}

function shortProbeName(value) {
  const base = String(value || "unknown").split(/[\\/]/).pop() || "unknown";
  const trimmed = base.replace(/\.(umap|uasset)$/i, "");
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 11)}...${trimmed.slice(-12)}`;
}

function raySphereIntersection(origin, direction, center, radius) {
  const offset = subtract(origin, center);
  const b = dot(offset, direction);
  const c = dot(offset, offset) - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return Number.NaN;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  if (far < 0) return Number.NaN;
  return near >= 0 ? near : far;
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (axisCanvas) {
    const axisWidth = Math.max(1, Math.floor(axisCanvas.clientWidth * dpr));
    const axisHeight = Math.max(1, Math.floor(axisCanvas.clientHeight * dpr));
    if (axisCanvas.width !== axisWidth || axisCanvas.height !== axisHeight) {
      axisCanvas.width = axisWidth;
      axisCanvas.height = axisHeight;
    }
  }
}

function makeStats() {
  const triangles = Math.floor(scene.indexCount / 3).toLocaleString();
  const vertices = scene.vertexCount.toLocaleString();
  const drawnTriangles = Math.floor(Math.min(scene.drawnIndexCount, scene.indexCount) / 3).toLocaleString();
  const resident = scene.meshCount.toLocaleString();
  const drawn = Math.min(scene.drawnMeshCount, scene.meshCount).toLocaleString();
  const total = scene.visibleMeshCount.toLocaleString();
  const loaded = scene.loadedEverCount.toLocaleString();
  const loading = scene.loadingCount ? `, ${scene.loadingCount} loading` : "";
  const failed = scene.failedCount ? `, ${scene.failedCount} skipped` : "";
  const budget = Number.isFinite(scene.residentBudget) ? `, budget ${scene.residentBudget.toLocaleString()}` : "";
  const hidden = scene.hiddenBackdropCount ? `, ${scene.hiddenBackdropCount.toLocaleString()} scenery hidden` : "";
  const pending = scene.pendingCandidateCount ? `, ${scene.pendingCandidateCount.toLocaleString()} near pending` : "";
  const speed = `speed ${formatSpeed(camera.effectiveSpeed)}`;
  const scale = `scale ${formatScale(settings.scale)}x`;
  const xray = settings.xray ? ", x-ray" : "";
  return `${resident}/${total} resident, ${drawn} drawn${budget}${hidden}${pending}; ${loaded} loaded, ${drawnTriangles}/${triangles} triangles, ${vertices} vertices, ${speed}, ${scale}${xray}${loading}${failed}.`;
}

function setStatus(message) {
  statusEl.textContent = message;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname}: ${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname}: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function createProgram(vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "failed to link shader program");
  }
  return program;
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "failed to compile shader");
  }
  return shader;
}

function createBounds() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function hasFiniteBounds(bounds) {
  return bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite);
}

function normalizeBounds(bounds) {
  if (!bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max)) return null;
  const normalized = {
    min: readPoint(bounds.min),
    max: readPoint(bounds.max),
  };
  return normalized.min && normalized.max && hasFiniteBounds(normalized) ? normalized : null;
}

function packedPositionScale(manifest) {
  const sourceScale = manifest.coordinateSystem === VIEWER_COORDINATE_SYSTEM ? [1, 1, 1] : [1, 1, -1];
  return sourceScale.map((scale, axis) => scale * userPositionScale[axis]);
}

function transformPackedPoint(point) {
  const parsed = readPoint(point);
  if (!parsed) return null;
  return parsed.map((value, axis) => value * scene.positionScale[axis]);
}

function transformPackedBounds(bounds) {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return null;

  const min = [...normalized.min];
  const max = [...normalized.max];
  for (let axis = 0; axis < 3; axis += 1) {
    if (scene.positionScale[axis] >= 0) continue;
    const oldMin = min[axis];
    min[axis] = max[axis] * scene.positionScale[axis];
    max[axis] = oldMin * scene.positionScale[axis];
  }

  return { min, max };
}

function readPoint(point) {
  if (!Array.isArray(point) || point.length < 3) return null;
  const parsed = [Number(point[0]), Number(point[1]), Number(point[2])];
  return parsed.every(Number.isFinite) ? parsed : null;
}

function boundsFromPositions(positions) {
  const bounds = createBounds();
  for (let i = 0; i + 2 < positions.length; i += 3) {
    includePoint(bounds, [positions[i], positions[i + 1], positions[i + 2]]);
  }
  return bounds;
}

function includePoint(bounds, point) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function mergeBounds(target, source) {
  includePoint(target, source.min);
  includePoint(target, source.max);
}

function makePointBounds(points) {
  const bounds = createBounds();
  for (const point of points) includePoint(bounds, point);
  return bounds;
}

function makeTrimmedBounds(points, lower, upper) {
  const bounds = createBounds();
  for (let axis = 0; axis < 3; axis += 1) {
    const values = points.map((point) => point[axis]).sort((a, b) => a - b);
    bounds.min[axis] = values[Math.floor((values.length - 1) * lower)];
    bounds.max[axis] = values[Math.floor((values.length - 1) * upper)];
    if (bounds.min[axis] === bounds.max[axis]) {
      bounds.min[axis] -= 0.5;
      bounds.max[axis] += 0.5;
    }
  }
  return bounds;
}

function unrealToViewerPoint(point) {
  const x = Number(point[0]);
  const y = Number(point[1]);
  const z = Number(point[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return [0, 0, 0];
  return [x, z, -y];
}

function transformUnrealPoint(point, transform) {
  const scale = Array.isArray(transform.scale) ? transform.scale : [1, 1, 1];
  const rotation = Array.isArray(transform.rotation) ? transform.rotation : [0, 0, 0, 1];
  const translation = Array.isArray(transform.translation) ? transform.translation : [0, 0, 0];
  const scaled = [
    Number(point[0]) * Number(scale[0]),
    Number(point[1]) * Number(scale[1]),
    Number(point[2]) * Number(scale[2]),
  ];
  const rotated = rotateByQuat(scaled, rotation.map(Number));
  return [
    rotated[0] + Number(translation[0]),
    rotated[1] + Number(translation[1]),
    rotated[2] + Number(translation[2]),
  ];
}

function rotateByQuat(point, quat) {
  const [qx, qy, qz, qw] = quat;
  const axis = [qx, qy, qz];
  const uv = cross(axis, point);
  const uuv = cross(axis, uv);
  return [
    point[0] + (uv[0] * qw + uuv[0]) * 2,
    point[1] + (uv[1] * qw + uuv[1]) * 2,
    point[2] + (uv[2] * qw + uuv[2]) * 2,
  ];
}

function normalizeScenePoint(point) {
  return [
    (point[0] - scene.center[0]) * scene.scale,
    (point[1] - scene.center[1]) * scene.scale,
    (point[2] - scene.center[2]) * scene.scale,
  ];
}

function entryDistance(entry) {
  return length(subtract(normalizeScenePoint(entry.center), camera.position));
}

function entryLoadScore(entry) {
  const center = normalizeScenePoint(entry.center);
  const toCenter = subtract(center, camera.position);
  const distance = length(toCenter);
  if (!Number.isFinite(distance) || distance <= 0) return Number.POSITIVE_INFINITY;
  const alignment = dot(toCenter, getForward()) / distance;
  const viewBonus = Math.max(0, alignment) * Math.min(12, distance * 0.4);
  const sizePenalty = Math.min(16, Math.sqrt(Number(entry.mesh.vertices || 0)) / 40);
  return distance - viewBonus + sizePenalty;
}

function chunkDistance(chunk) {
  return length(subtract(normalizeScenePoint(chunk.center), camera.position));
}

function boundsCenter(bounds) {
  return [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
}

function boundsSize(bounds) {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
}

function boundsRadius(bounds) {
  if (!bounds || !hasFiniteBounds(bounds)) return 0;
  return length(boundsSize(bounds)) * 0.5;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy * 0.5);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookFrom(eye, forward, up) {
  const z = normalize([-forward[0], -forward[1], -forward[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function addScaled(target, value, scale) {
  target[0] += value[0] * scale;
  target[1] += value[1] * scale;
  target[2] += value[2] * scale;
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(value) {
  return Math.hypot(value[0], value[1], value[2]);
}

function normalize(value) {
  const len = length(value);
  if (len <= 0) return [0, 0, 0];
  return [value[0] / len, value[1] / len, value[2] / len];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function parseOptionalNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBudget(value, fallback) {
  if (value && value.toLowerCase() === "all") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseRadius(value, fallback) {
  if (value && value.toLowerCase() === "all") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseSpeed(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 0.1, 10) : fallback;
}

function parseScale(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 0.25, 4) : fallback;
}

function parsePositionScale(value) {
  const scale = [1, 1, 1];
  for (const axis of String(value || "").toLowerCase().split(/[,\s+]+/)) {
    if (axis === "none" || axis === "0" || axis === "false") continue;
    if (axis === "x") scale[0] *= -1;
    if (axis === "y") scale[1] *= -1;
    if (axis === "z") scale[2] *= -1;
  }
  return scale;
}

function formatSpeed(value) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatScale(value) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatCoord(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "--";
}

function formatDegrees(value) {
  return Number.isFinite(value) ? `${normalizeDegrees(value).toFixed(1)}deg` : "--";
}

function formatSignedDegrees(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}deg` : "--";
}

function radiansToDegrees(value) {
  return value * 180 / Math.PI;
}

function normalizeDegrees(value) {
  let normalized = value % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

const VERTEX_SOURCE = `#version 300 es
precision highp float;

in vec3 aPosition;

uniform mat4 uProjection;
uniform mat4 uView;
uniform vec3 uCenter;
uniform float uScale;
uniform vec3 uPositionScale;

out vec3 vWorld;

void main() {
  vec3 world = ((aPosition * uPositionScale) - uCenter) * uScale;
  vWorld = world;
  gl_Position = uProjection * uView * vec4(world, 1.0);
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec3 vWorld;

uniform vec3 uLight;
uniform float uOpacity;

out vec4 fragColor;

void main() {
  vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (!gl_FrontFacing) normal = -normal;
  float light = abs(dot(normal, normalize(uLight)));
  float rim = pow(1.0 - abs(dot(normal, normalize(-vWorld))), 2.0) * 0.22;
  vec3 base = vec3(0.58, 0.62, 0.66);
  vec3 color = base * (0.28 + light * 0.72) + rim;
  fragColor = vec4(color, uOpacity);
}
`;
