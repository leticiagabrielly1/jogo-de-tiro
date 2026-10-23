"use strict";

(() => {
    const $ = id => document.getElementById(id);
    const random = (min, max) => min + Math.random() * (max - min);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    const defaults = {
        volume: 70,
        sfx: 80,
        sensitivity: 50,
        quality: "medium",
        sound: true,
        effects: true,
        particles: true,
        shake: true,
        showMap: true
    };

    let settings = { ...defaults };

    try {
        const saved = JSON.parse(
            localStorage.getItem("deadzone_settings_v4") || "{}"
        );

        for (const key of ["volume", "sfx", "sensitivity"]) {
            if (Number.isFinite(saved[key])) {
                settings[key] = clamp(
                    saved[key],
                    key === "sensitivity" ? 10 : 0,
                    100
                );
            }
        }

        for (const key of [
            "sound", "effects", "particles", "shake", "showMap"
        ]) {
            if (typeof saved[key] === "boolean") {
                settings[key] = saved[key];
            }
        }

        if (["low", "medium", "high"].includes(saved.quality)) {
            settings.quality = saved.quality;
        }
    } catch (_) {}

    let bootstrap = {};
    let bootstrapError = "";

    try {
        bootstrap = JSON.parse($("bootstrap").textContent);

        if (!bootstrap.csrf) {
            throw new Error("Token de sessão ausente.");
        }
    } catch (_) {
        bootstrapError =
            "Abra o jogo pelo endereço do Flask, não pelo Live Server.";
    }

    const difficulties = {
        easy: { health: .75, speed: .82, damage: .65, count: .8 },
        normal: { health: 1, speed: 1, damage: 1, count: 1 },
        hard: { health: 1.35, speed: 1.12, damage: 1.4, count: 1.25 }
    };

    const weaponDefinitions = [
        {
            name: "PISTOLA TÁTICA",
            short: "PISTOLA",
            size: 12,
            reserve: 48,
            damage: 45,
            delay: .23,
            reload: 1.2,
            pellets: 1,
            spread: .004,
            automatic: false,
            color: 0xff6677
        },
        {
            name: "ESCOPETA",
            short: "ESCOPETA",
            size: 6,
            reserve: 24,
            damage: 24,
            delay: .75,
            reload: 1.65,
            pellets: 8,
            spread: .065,
            automatic: false,
            color: 0xffbb66
        },
        {
            name: "FUZIL DE ASSALTO",
            short: "FUZIL",
            size: 30,
            reserve: 120,
            damage: 30,
            delay: .095,
            reload: 1.45,
            pellets: 1,
            spread: .016,
            automatic: true,
            color: 0xffddaa
        },
        {
            name: "CANHÃO DE PLASMA",
            short: "PLASMA",
            size: 4,
            reserve: 16,
            damage: 145,
            delay: .85,
            reload: 1.9,
            pellets: 1,
            spread: 0,
            automatic: false,
            color: 0xbb66ff
        }
    ];

    const enemyDefinitions = {
        common: {
            hp: 65, growth: 12, speed: 3.5,
            damage: 15, scale: 1, color: 0x596b50, points: 1
        },
        fast: {
            hp: 40, growth: 8, speed: 5.8,
            damage: 10, scale: .85, color: 0x967247, points: 1.3
        },
        tank: {
            hp: 190, growth: 30, speed: 2.1,
            damage: 30, scale: 1.4, color: 0x69526c, points: 2.2
        },
        special: {
            hp: 110, growth: 18, speed: 4.1,
            damage: 22, scale: 1.1, color: 0x36886e, points: 2.6
        }
    };

    const pickupDefinitions = [
        ["health", 0xff5577, "VIDA +40"],
        ["shield", 0xddaa66, "COLETE +40"],
        ["ammo", 0xdddddd, "MUNIÇÃO EXTRA"],
        ["damage", 0xff9955, "DANO ×1,6"],
        ["speed", 0x55ccff, "VELOCIDADE EXTRA"],
        ["slow", 0xbb77ff, "TEMPO LENTO"]
    ];

    const state = {
        mode: "profile",
        nickname: bootstrap.nickname || "",
        difficulty: "normal",
        health: 100,
        shield: 100,
        stamina: 100,
        score: 0,
        kills: 0,
        headshots: 0,
        elapsed: 0,
        wave: 1,
        selected: 0,
        combo: 0,
        comboUntil: 0,
        spawnLeft: 0,
        spawnTimer: 0,
        waveTimer: 0,
        cooldown: 0,
        reloadLeft: 0,
        lastDamage: -100,
        damageUntil: 0,
        speedUntil: 0,
        slowUntil: 0,
        noticeUntil: 0,
        bannerUntil: 0,
        hitUntil: 0,
        flashUntil: 0,
        feet: 0,
        verticalSpeed: 0,
        flashlight: false,
        exhausted: false,
        matchPromise: null,
        result: null,
        saving: false
    };

    let renderer = null;
    let scene = null;
    let camera = null;
    let player = null;
    let pitch = null;
    let moon = null;
    let flashlight = null;
    let muzzle = null;

    let worldReady = false;
    let currentScreen = "profile";
    let returnScreen = "menu";
    let shooting = false;
    let recoil = 0;
    let shakeAmount = 0;
    let hudTimer = 0;
    let weapons = [];

    let editorRenderer = null;
    let editorScene = null;
    let editorCamera = null;
    let editorMesh = null;

    const keys = new Set();
    const colliders = [];
    const rayTargets = [];
    const lootBoxes = [];
    const lamps = [];
    const enemies = [];
    const projectiles = [];
    const particles = [];
    const pickups = [];
    const weaponMeshes = [];
    const customObjects = [];
    const textureCache = new Map();

    function showError(message) {
        $("global-error").textContent = message;
        $("global-error").hidden = false;
    }

    function showScreen(name) {
        currentScreen = name;

        document.querySelectorAll(".screen").forEach(element => {
            element.hidden = element.id !== `${name}-screen`;
        });

        $("hud").hidden = name !== "playing";
    }

    function openMenu() {
        state.mode = "menu";

        $("welcome").textContent =
            `${state.nickname}, explore a cidade, encontre suprimentos e sobreviva.`;

        showScreen("menu");
    }

    async function api(path, method = "GET", body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);

        try {
            const response = await fetch(path, {
                method,
                credentials: "same-origin",
                signal: controller.signal,
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": bootstrap.csrf || ""
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(
                    data.error || `Erro ${response.status} no servidor.`
                );
            }

            return data;
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error(
                    "O servidor demorou a responder. Confira o terminal do Flask."
                );
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    const audio = {
        context: null,

        init() {
            try {
                const AudioContext =
                    window.AudioContext || window.webkitAudioContext;

                if (!AudioContext) return;

                if (!this.context) {
                    this.context = new AudioContext();
                }

                this.context.resume().catch(() => {});
            } catch (_) {}
        },

        tone(start, end, duration = .15, type = "sine", strength = .2) {
            if (!this.context || !settings.sound) return;

            const oscillator = this.context.createOscillator();
            const gain = this.context.createGain();
            const now = this.context.currentTime;

            oscillator.type = type;
            oscillator.frequency.setValueAtTime(start, now);

            oscillator.frequency.exponentialRampToValueAtTime(
                Math.max(1, end),
                now + duration
            );

            const volume =
                strength * settings.volume / 100 * settings.sfx / 100;

            gain.gain.setValueAtTime(Math.max(.0001, volume), now);
            gain.gain.exponentialRampToValueAtTime(.0001, now + duration);

            oscillator.connect(gain);
            gain.connect(this.context.destination);

            oscillator.start();
            oscillator.stop(now + duration + .02);

            oscillator.onended = () => {
                oscillator.disconnect();
                gain.disconnect();
            };
        }
    };

    function material(color, extra = {}) {
        return new THREE.MeshStandardMaterial({
            color,
            roughness: .8,
            ...extra
        });
    }

    function box(parent, width, height, depth, x, y, z, color, extra = {}) {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(width, height, depth),
            material(color, extra)
        );

        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        parent.add(mesh);
        return mesh;
    }

    function addCollision(mesh) {
        mesh.updateWorldMatrix(true, true);

        const collider = {
            mesh,
            box: new THREE.Box3().setFromObject(mesh)
        };

        colliders.push(collider);
        rayTargets.push(mesh);

        return collider;
    }

    function disposeObject(object) {
        if (!object) return;

        object.removeFromParent();

        const geometries = new Set();
        const materials = new Set();

        object.traverse(child => {
            if (child.geometry) geometries.add(child.geometry);

            if (child.material) {
                const items = Array.isArray(child.material)
                    ? child.material
                    : [child.material];

                items.forEach(item => materials.add(item));
            }
        });

        geometries.forEach(item => item.dispose());
        materials.forEach(item => item.dispose());
    }

    function clearTransient(array) {
        array.forEach(item => disposeObject(item.mesh));
        array.length = 0;
    }

    function blocked(x, z, radius = .5, feet = 0, height = 1.7) {
        if (Math.abs(x) + radius > 89 || Math.abs(z) + radius > 89) {
            return true;
        }

        const bounds = new THREE.Box3(
            new THREE.Vector3(x - radius, feet + .12, z - radius),
            new THREE.Vector3(x + radius, feet + height, z + radius)
        );

        return colliders.some(item => bounds.intersectsBox(item.box));
    }

    function lineBlocked(start, end) {
        const direction = end.clone().sub(start);
        const length = direction.length();

        if (length < .001) return false;

        const ray = new THREE.Ray(start, direction.normalize());
        const point = new THREE.Vector3();

        return colliders.some(collider => {
            const hit = ray.intersectBox(collider.box, point);
            return hit && start.distanceTo(point) < length - .1;
        });
    }

    function makeTexture(type, color) {
        const key = `${type}-${color}`;

        if (textureCache.has(key)) {
            return textureCache.get(key);
        }

        const surface = document.createElement("canvas");
        surface.width = 256;
        surface.height = 256;

        const context = surface.getContext("2d");
        context.fillStyle = color;
        context.fillRect(0, 0, 256, 256);

        if (type === "brick") {
            for (let row = 0; row < 8; row++) {
                const offset = row % 2 ? -32 : 0;

                for (let column = 0; column < 5; column++) {
                    const x = offset + column * 64;
                    const y = row * 32;

                    context.fillStyle = `rgba(0,0,0,${random(.04, .2)})`;
                    context.fillRect(x + 2, y + 2, 60, 28);
                    context.strokeStyle = "rgba(15,20,25,.4)";
                    context.lineWidth = 2;
                    context.strokeRect(x, y, 64, 32);
                }
            }
        }

        for (let index = 0; index < 2600; index++) {
            context.fillStyle = Math.random() > .5
                ? `rgba(255,255,255,${random(.015, .08)})`
                : `rgba(0,0,0,${random(.02, .15)})`;

            const size = type === "asphalt" ? random(1, 3) : random(1, 6);

            context.fillRect(
                random(0, 256),
                random(0, 256),
                size,
                size
            );
        }

        if (type !== "asphalt") {
            for (let index = 0; index < 16; index++) {
                context.fillStyle = `rgba(8,12,15,${random(.03, .12)})`;

                context.fillRect(
                    random(0, 256),
                    random(0, 256),
                    random(2, 10),
                    random(20, 120)
                );
            }
        }

        const texture = new THREE.CanvasTexture(surface);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;

        texture.anisotropy = Math.min(
            4,
            renderer.capabilities.getMaxAnisotropy()
        );

        textureCache.set(key, texture);

        return texture;
    }

    function texturedBox(
        parent, width, height, depth,
        x, y, z, color, type = "concrete", collision = false
    ) {
        const mesh = box(
            parent, width, height, depth, x, y, z, 0xffffff,
            {
                map: makeTexture(type, color),
                roughness: type === "asphalt" ? .65 : .9
            }
        );

        if (collision) addCollision(mesh);

        return mesh;
    }

    function groundPlane(
        width, depth, x, z, color, y = .04, roughness = .8
    ) {
        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(width, depth),
            material(color, { roughness })
        );

        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, y, z);
        mesh.receiveShadow = true;

        scene.add(mesh);
        return mesh;
    }

    function sign(
        text, x, y, z,
        width = 5, height = 1,
        foreground = "#e7e8de",
        background = "#253438",
        rotation = 0
    ) {
        const surface = document.createElement("canvas");
        surface.width = 768;
        surface.height = 192;

        const context = surface.getContext("2d");
        context.fillStyle = background;
        context.fillRect(0, 0, 768, 192);

        context.strokeStyle = foreground;
        context.lineWidth = 7;
        context.strokeRect(15, 15, 738, 162);

        context.font = "bold 62px Arial";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillStyle = foreground;
        context.fillText(text, 384, 100, 700);

        const texture = new THREE.CanvasTexture(surface);
        textureCache.set(`sign-${texture.uuid}`, texture);

        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(width, height),
            material(0xffffff, {
                map: texture,
                emissive: 0xffffff,
                emissiveMap: texture,
                emissiveIntensity: .15,
                side: THREE.DoubleSide
            })
        );

        mesh.position.set(x, y, z);
        mesh.rotation.y = rotation;
        scene.add(mesh);

        return mesh;
    }

    function createLoot(x, z) {
        const mesh = new THREE.Group();
        mesh.position.set(x, 0, z);
        scene.add(mesh);

        const body = box(mesh, 1.3, .7, .85, 0, .35, 0, 0x526444);
        const lid = box(mesh, 1.4, .13, .95, 0, .77, 0, 0x7a965d);

        const marker = new THREE.Mesh(
            new THREE.OctahedronGeometry(.17),
            new THREE.MeshBasicMaterial({ color: 0x77ffbb })
        );

        marker.position.y = 1.2;
        mesh.add(marker);

        const roll = Math.random();

        lootBoxes.push({
            mesh,
            body,
            lid,
            marker,
            used: false,
            type: roll < .6 ? "ammo" : roll < .87 ? "health" : "arsenal"
        });
    }

    function createTree(x, z) {
        const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(.22, .35, 3.5, 6),
            material(0x4d382a)
        );

        trunk.position.set(x, 1.75, z);
        trunk.castShadow = true;

        scene.add(trunk);
        addCollision(trunk);

        const leaves = new THREE.Mesh(
            new THREE.SphereGeometry(1.8, 8, 6),
            material(0x344b36)
        );

        leaves.position.set(x, 4, z);
        leaves.scale.y = 1.2;
        leaves.castShadow = true;

        scene.add(leaves);
        rayTargets.push(leaves);
    }

    function createCar(x, z, rotation = 0) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        group.rotation.y = rotation;
        scene.add(group);

        box(group, 4.3, 1, 1.9, 0, .8, 0, 0x4d3641);
        box(group, 2.2, .85, 1.7, -.15, 1.7, 0, 0x273747);
        box(group, .12, .25, 1.8, 2.18, .6, 0, 0x77777a);

        for (const wx of [-1.4, 1.4]) {
            for (const wz of [-1, 1]) {
                const wheel = new THREE.Mesh(
                    new THREE.CylinderGeometry(.43, .43, .3, 10),
                    material(0x15171b)
                );

                wheel.rotation.x = Math.PI / 2;
                wheel.position.set(wx, .43, wz);
                group.add(wheel);
            }
        }

        addCollision(group);
    }

    function createLamp(x, z, lit) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        scene.add(group);

        box(group, .16, 6, .16, 0, 3, 0, 0x32383e);
        box(group, 1.5, .13, .14, .6, 5.9, 0, 0x32383e);

        box(group, .6, .14, .45, 1.2, 5.75, 0, 0xffd79b, {
            emissive: 0xffc77b,
            emissiveIntensity: lit ? .8 : .1
        });

        if (lit) {
            const light = new THREE.PointLight(0xffcb89, .8, 14, 2);
            light.position.set(1.2, 5.5, 0);
            group.add(light);

            lamps.push({ light, phase: random(0, 10) });
        }
    }

    function windowPanel(parent, x, y, z, width = 1.4, height = 1.9) {
        const lit = Math.random() < .28;

        box(parent, width + .2, height + .2, .13, x, y, z, 0x242a30);

        box(parent, width, height, .15, x, y, z + .02,
            lit ? 0xb39a63 : 0x1d2b3a, {
                metalness: .25,
                roughness: .35,
                emissive: lit ? 0xffc77a : 0x233449,
                emissiveIntensity: lit ? .45 : .08
            }
        );

        box(parent, .065, height, .18, x, y, z + .04, 0x282b32);
        box(parent, width, .065, .18, x, y, z + .04, 0x282b32);

        box(
            parent, width + .35, .12, .38,
            x, y - height / 2, z + .08,
            0x555b60
        );
    }

    function detailedBuilding(x, z, width, depth, floors, name, color) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        scene.add(group);

        const height = floors * 3.5 + .5;
        const doorWidth = 3.2;
        const sideWidth = (width - doorWidth) / 2;

        const walls = [
            [sideWidth, height, .45,
                -(doorWidth + sideWidth) / 2, height / 2, depth / 2],
            [sideWidth, height, .45,
                (doorWidth + sideWidth) / 2, height / 2, depth / 2],
            [doorWidth, height - 3, .45,
                0, 3 + (height - 3) / 2, depth / 2],
            [width, height, .45, 0, height / 2, -depth / 2],
            [.45, height, depth, -width / 2, height / 2, 0],
            [.45, height, depth, width / 2, height / 2, 0]
        ];

        walls.forEach(dimensions => {
            texturedBox(
                group,
                ...dimensions,
                color,
                floors > 4 ? "concrete" : "brick",
                true
            );
        });

        box(group, width, .12, depth, 0, -.02, 0, 0x383733);

        for (let floor = 1; floor <= floors; floor++) {
            const level = floor * 3.5;

            const slab = box(
                group,
                width + .35, .22, depth + .35,
                0, level, 0,
                0x575b60
            );

            rayTargets.push(slab);

            if (floor < floors) {
                for (
                    let windowX = -width / 2 + 2;
                    windowX < width / 2 - 1;
                    windowX += 3
                ) {
                    windowPanel(
                        group, windowX, level + 1.7, depth / 2 + .27
                    );
                }
            }
        }

        for (const side of [-1, 1]) {
            box(
                group, .32, height, .55,
                side * (width / 2 - .25),
                height / 2, depth / 2 + .1,
                0x4b5056
            );

            windowPanel(
                group,
                side * (doorWidth / 2 + sideWidth / 2),
                1.65,
                depth / 2 + .27,
                Math.max(1.3, sideWidth - 1),
                2.2
            );
        }

        rayTargets.push(box(
            group, width + .6, .23, 2.1,
            0, 3.1, depth / 2 + .7,
            0x34373d
        ));

        rayTargets.push(box(
            group, width + .5, .7, depth + .5,
            0, height + .2, 0,
            0x303740
        ));

        rayTargets.push(box(
            group, width * .32, 1.5, depth * .3,
            -width * .2, height + 1.25, 0,
            0x414850
        ));

        const tank = new THREE.Mesh(
            new THREE.CylinderGeometry(1.2, 1.2, 2.2, 12),
            material(0x424a55, { metalness: .45 })
        );

        tank.position.set(width * .25, height + 1.8, -depth * .2);
        group.add(tank);
        rayTargets.push(tank);

        box(
            group, .09, 3.7, .09,
            width * .3, height + 3.7, -depth * .2,
            0x777d85
        );

        sign(
            name,
            x, 3.82, z + depth / 2 + .4,
            Math.min(width - 1, 10), .95,
            "#e2d7bb",
            floors % 2 ? "#3e252c" : "#263d3b"
        );

        addCollision(box(
            group,
            width * .45, .95, 1.1,
            -width * .18, .475, -depth * .12,
            0x62503e
        ));

        for (const shelfX of [-width / 2 + .8, width / 2 - .8]) {
            addCollision(box(
                group, .65, 2, depth * .48,
                shelfX, 1, -1,
                0x444b48
            ));

            for (let level = .4; level < 2; level += .5) {
                box(
                    group, .8, .08, depth * .48,
                    shelfX, level, -1,
                    0x7d8076
                );
            }
        }

        createLoot(x, z + depth / 2 - 2.4);
    }

    function bench(x, z, rotation = 0) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        group.rotation.y = rotation;
        scene.add(group);

        for (let index = 0; index < 4; index++) {
            box(group, 2.5, .11, .13, 0, .65, -.25 + index * .17, 0x6d533d);
            box(group, 2.5, .12, .12, 0, .95 + index * .14, .38, 0x6d533d);
        }

        for (const side of [-.9, .9]) {
            box(group, .12, .7, .55, side, .35, 0, 0x2c3338);
        }

        addCollision(group);
    }

    function barrel(x, z) {
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(.42, .42, 1.15, 12),
            material(0x6b3c32, { metalness: .3, roughness: .7 })
        );

        mesh.position.set(x, .575, z);
        mesh.castShadow = true;
        scene.add(mesh);
        addCollision(mesh);
    }

    function barricade(x, z, rotation = 0) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        group.rotation.y = rotation;
        scene.add(group);

        texturedBox(group, 3.4, .9, .65, 0, .45, 0, "#66635c");

        for (let index = -3; index <= 3; index++) {
            const stripe = box(
                group, .26, .7, .035,
                index * .45, .48, .35,
                index % 2 ? 0xc1a149 : 0x25272a
            );

            stripe.rotation.z = -.3;
        }

        addCollision(group);
    }

    function crossing(x, z, rotation = 0) {
        const group = new THREE.Group();
        group.position.set(x, .065, z);
        group.rotation.y = rotation;
        scene.add(group);

        for (let index = -3; index <= 3; index++) {
            const stripe = box(
                group, .55, .012, 2.8,
                index * 1.02, 0, 0,
                0x9c9d93
            );

            stripe.castShadow = false;
        }
    }

    function createWorld() {
        scene.background = new THREE.Color(0x0b1220);
        scene.fog = new THREE.FogExp2(0x101927, .0095);

        texturedBox(
            scene, 190, .15, 190,
            0, -.12, 0,
            "#303733"
        );

        const roads = [-80, -40, 0, 40, 80];

        for (const line of roads) {
            texturedBox(
                scene, 186, .035, 8,
                0, -.015, line,
                "#1c222b", "asphalt"
            );

            texturedBox(
                scene, 8, .035, 186,
                line, -.01, 0,
                "#1c222b", "asphalt"
            );

            for (let position = -86; position <= 86; position += 9) {
                if (roads.some(cross => Math.abs(position - cross) < 6)) {
                    continue;
                }

                groundPlane(3.5, .1, position, line - .15, 0xb8a872);
                groundPlane(3.5, .1, position, line + .15, 0xb8a872);
                groundPlane(.1, 3.5, line - .15, position, 0xb8a872, .045);
                groundPlane(.1, 3.5, line + .15, position, 0xb8a872, .045);
            }
        }

        const names = [
            "MERCADO CENTRAL", "HOTEL AURORA",
            "FARMÁCIA VIDA", "CINEMA ATLAS",
            "CAFÉ DA ESQUINA", "OFICINA NORTE",
            "ARMAZÉM 07", "EDIFÍCIO ORION",
            "LIVRARIA LUZ", "CLÍNICA CENTRAL",
            "GALERIA NOVA", "RÁDIO METRÓPOLE",
            "MERCADO SUL", "HOTEL IMPERIAL",
            "DEPÓSITO 13", "ESTAÇÃO VELHA"
        ];

        const colors = [
            "#8e7766", "#817f77", "#6b7779",
            "#947766", "#7e6c64", "#758079"
        ];

        let district = 0;

        for (const x of [-60, -20, 20, 60]) {
            for (const z of [-60, -20, 20, 60]) {
                texturedBox(
                    scene, 31.5, .11, 31.5,
                    x, -.005, z,
                    "#565952"
                );

                for (const side of [-1, 1]) {
                    box(
                        scene, 31.5, .15, .2,
                        x, .035, z + side * 15.65,
                        0x7c7c71
                    );

                    box(
                        scene, .2, .15, 31.5,
                        x + side * 15.65, .035, z,
                        0x7c7c71
                    );
                }

                if (x === 20 && z === 20) {
                    groundPlane(27, 27, x, z, 0x263c2e, .065);
                    groundPlane(4, 27, x, z, 0x777365, .075);
                    groundPlane(27, 4, x, z, 0x777365, .08);

                    const fountain = new THREE.Mesh(
                        new THREE.CylinderGeometry(3, 3.2, .65, 24),
                        material(0x777b79)
                    );

                    fountain.position.set(x, .325, z);
                    scene.add(fountain);
                    addCollision(fountain);

                    const water = new THREE.Mesh(
                        new THREE.CircleGeometry(2.65, 24),
                        material(0x284f5c, {
                            metalness: .55,
                            roughness: .15
                        })
                    );

                    water.rotation.x = -Math.PI / 2;
                    water.position.set(x, .66, z);
                    scene.add(water);

                    for (const dx of [-9, 9]) {
                        for (const dz of [-9, 9]) {
                            createTree(x + dx, z + dz);
                        }
                    }

                    bench(x - 7, z + 5, Math.PI / 2);
                    bench(x + 7, z - 5, -Math.PI / 2);
                    bench(x, z - 10);

                    sign("PRAÇA DA MEMÓRIA", x, 2.4, z + 14, 5.3, .8);
                    createLoot(x + 7, z + 8);
                } else if (x === -20 && z === 20) {
                    texturedBox(
                        scene, 27, .025, 27,
                        x, .06, z,
                        "#252b31", "asphalt"
                    );

                    for (let index = -2; index <= 2; index++) {
                        for (const side of [-1, 1]) {
                            const spotX = x + index * 4.5;
                            const spotZ = z + side * 8;

                            groundPlane(
                                .1, 6, spotX - 2, spotZ, 0xb2b0a0, .09
                            );

                            if ((index + side) % 2 === 0) {
                                createCar(spotX, spotZ, Math.PI / 2);
                            }
                        }
                    }

                    sign("ESTACIONAMENTO", x, 3.3, z + 14, 7, 1);
                    barrel(x - 12, z - 11);
                    barrel(x - 11, z - 11.5);
                    createLoot(x + 10, z - 11);
                } else {
                    detailedBuilding(
                        x, z - 2, 23, 19,
                        [3, 6, 4, 7, 2, 5][district % 6],
                        names[district],
                        colors[district % colors.length]
                    );

                    bench(x - 8, z + 12);
                    barrel(x + 13, z - 10);

                    addCollision(box(
                        scene, 1, 1.25, .9,
                        x + 12.5, .625, z + 11.5,
                        0x344c43
                    ));

                    if (district % 2 === 0) {
                        createTree(x - 13, z + 11);
                    }

                    for (let index = 0; index < 4; index++) {
                        const rubble = box(
                            scene,
                            random(.2, .55),
                            random(.1, .25),
                            random(.2, .6),
                            x + random(-9, 9),
                            .15,
                            z + random(11, 13),
                            0x686763
                        );

                        rubble.rotation.y = random(0, Math.PI);
                        rubble.castShadow = false;
                    }
                }

                createLamp(x - 14, z + 14, district % 3 === 0);
                district++;
            }
        }

        for (const x of [-40, 0, 40]) {
            for (const z of [-40, 0, 40]) {
                crossing(x, z + 6.3);
                crossing(x + 6.3, z, Math.PI / 2);
            }
        }

        box(scene, .12, 3.7, .12, 5.5, 1.85, 5.5, 0x545b61);
        sign("AV. CENTRAL", 5.5, 3.35, 5.5, 3.3, .65);

        createCar(3, -22, .12);
        createCar(-43, 18, -.12);
        createCar(42, -59, .22);
        createCar(18, 42, Math.PI / 2);

        barricade(-3, -73, .15);
        barricade(3, -77, -.12);
        barricade(75, 3, Math.PI / 2);

        sign(
            "QUARENTENA", 0, 3.7, -76,
            8, 1.6, "#f2d07a", "#4a2725"
        );

        sign(
            "NÃO ULTRAPASSE", 76, 2.8, 0,
            5.5, 1, "#edb4aa", "#44262d", -Math.PI / 2
        );

        for (let index = 0; index < 12; index++) {
            const puddle = groundPlane(
                random(1, 3),
                random(.5, 1.6),
                random(-75, 75),
                [-40, 0, 40][index % 3] + random(-2.7, 2.7),
                0x263342,
                .055,
                .12
            );

            puddle.material.metalness = .5;
            puddle.rotation.z = random(-.4, .4);
        }

        createLoot(5, 8);
        createLoot(-6, -8);

        for (let index = 0; index < 32; index++) {
            const angle = index / 32 * Math.PI * 2;
            const distance = random(112, 136);
            const height = random(20, 58);

            const tower = box(
                scene,
                random(9, 16), height, random(9, 16),
                Math.cos(angle) * distance,
                height / 2,
                Math.sin(angle) * distance,
                0x182334
            );

            tower.castShadow = false;
            tower.receiveShadow = false;
        }
    }

    function buildWeapons() {
        weaponDefinitions.forEach((definition, index) => {
            const mesh = new THREE.Group();
            mesh.position.set(.25, -.25, -.5);
            camera.add(mesh);

            box(
                mesh,
                .1 + index * .01,
                .12,
                [.35, .65, .55, .65][index],
                0, 0, 0,
                0x2a3342,
                { metalness: .65, roughness: .3 }
            );

            box(mesh, .07, .2, .1, 0, -.13, .08, 0x45404a);

            if (index === 2) {
                box(mesh, .07, .2, .1, 0, -.16, -.12, 0x252c35);
            }

            if (index === 3) {
                box(
                    mesh, .075, .075, .5,
                    0, .1, 0,
                    0xaa55ff,
                    { emissive: 0x8822ee, emissiveIntensity: 1.3 }
                );
            }

            mesh.traverse(child => {
                child.castShadow = false;
                child.receiveShadow = false;
            });

            weaponMeshes.push(mesh);
        });
    }

    function applySettings() {
        if (renderer && moon) {
            const ratios = { low: 1, medium: 1.25, high: 1.75 };

            renderer.setPixelRatio(
                Math.min(devicePixelRatio || 1, ratios[settings.quality])
            );

            renderer.setSize(innerWidth, innerHeight);
            renderer.shadowMap.enabled = settings.quality !== "low";
            moon.castShadow = settings.quality !== "low";
        }

        $("vignette").hidden = !settings.effects;
        $("minimap").parentElement.hidden = !settings.showMap;

        if (!settings.effects) {
            $("damage-overlay").classList.remove("critical");
            $("damage-overlay").style.opacity = 0;
        }
    }

    function cleanupFailedWorld() {
        if (scene) disposeObject(scene);

        textureCache.forEach(texture => texture.dispose());
        textureCache.clear();

        [
            colliders, rayTargets, lootBoxes, lamps,
            enemies, projectiles, particles, pickups,
            weaponMeshes, customObjects
        ].forEach(array => array.length = 0);

        if (renderer) renderer.dispose();

        renderer = null;
        scene = null;
        camera = null;
        player = null;
        pitch = null;
        moon = null;
        flashlight = null;
        muzzle = null;
        worldReady = false;
    }

    function initializeWorld() {
        if (worldReady) return;

        if (!window.THREE) {
            throw new Error(
                "O Three.js não carregou. Confira a conexão e atualize a página."
            );
        }

        try {
            renderer = new THREE.WebGLRenderer({
                canvas: $("game-canvas"),
                antialias: true
            });

            renderer.shadowMap.type = THREE.PCFSoftShadowMap;

            scene = new THREE.Scene();

            camera = new THREE.PerspectiveCamera(
                75, innerWidth / innerHeight, .08, 280
            );

            player = new THREE.Group();
            pitch = new THREE.Group();

            player.position.set(0, 1.7, 0);
            player.add(pitch);
            pitch.add(camera);
            scene.add(player);

            const ambient = new THREE.HemisphereLight(
                0x99abc8, 0x292128, .75
            );

            moon = new THREE.DirectionalLight(0xa4bce5, .8);
            moon.position.set(40, 80, 30);

            moon.shadow.mapSize.set(1024, 1024);
            moon.shadow.camera.left = -65;
            moon.shadow.camera.right = 65;
            moon.shadow.camera.top = 65;
            moon.shadow.camera.bottom = -65;
            moon.shadow.camera.far = 200;
            moon.shadow.bias = -.001;

            scene.add(ambient, moon);

            flashlight = new THREE.SpotLight(
                0xe0ebff, 0, 45, Math.PI / 7, .55, 1.3
            );

            const target = new THREE.Object3D();
            target.position.set(0, 0, -20);

            flashlight.position.set(.15, -.1, 0);
            flashlight.target = target;

            camera.add(flashlight, target);

            muzzle = new THREE.PointLight(0xffaa77, 0, 5);
            muzzle.position.set(.2, -.15, -.7);
            camera.add(muzzle);

            applySettings();
            createWorld();
            buildWeapons();

            scene.updateMatrixWorld(true);
            worldReady = true;
        } catch (error) {
            cleanupFailedWorld();
            throw error;
        }
    }

    function formatTime(seconds) {
        return (
            String(Math.floor(seconds / 60)).padStart(2, "0") +
            ":" +
            String(Math.floor(seconds % 60)).padStart(2, "0")
        );
    }

    function notice(text, duration = 2.4) {
        $("notice").textContent = text;
        state.noticeUntil = state.elapsed + duration;
    }

    function banner(text, duration = 2.7) {
        $("wave-banner").textContent = text;
        state.bannerUntil = state.elapsed + duration;
    }

    function updateHUD() {
        if (!weapons.length) return;

        $("hud-wave").textContent = state.wave;
        $("hud-enemies").textContent = enemies.length + state.spawnLeft;
        $("hud-score").textContent = state.score.toLocaleString("pt-BR");
        $("hud-time").textContent = formatTime(state.elapsed);

        for (const name of ["health", "shield", "stamina"]) {
            $(`${name}-text`).textContent = Math.ceil(Math.max(0, state[name]));
            $(`${name}-fill`).style.width = `${clamp(state[name], 0, 100)}%`;
        }

        const weapon = weapons[state.selected];

        $("ammo-clip").textContent = weapon.clip;
        $("ammo-reserve").textContent = ` / ${weapon.ammo}`;
        $("weapon-name").textContent = weapon.name;

        $("reload-status").textContent = state.reloadLeft > 0
            ? `RECARREGANDO ${state.reloadLeft.toFixed(1)}s`
            : "R PARA RECARREGAR";

        $("flashlight-text").textContent =
            state.flashlight ? "ligada" : "desligada";

        $("combo").textContent =
            state.combo > 1 && state.elapsed < state.comboUntil
                ? `COMBO ×${state.combo}`
                : "";

        $("damage-overlay").classList.toggle(
            "critical",
            settings.effects &&
            state.mode === "playing" &&
            state.health <= 30
        );

        $("powerups").replaceChildren();

        [
            ["DANO ×1,6", state.damageUntil],
            ["VELOCIDADE", state.speedUntil],
            ["TEMPO LENTO", state.slowUntil]
        ].forEach(([label, expiration]) => {
            if (expiration <= state.elapsed) return;

            const chip = document.createElement("div");
            chip.className = "powerup";
            chip.textContent =
                `${label} · ${Math.ceil(expiration - state.elapsed)}s`;

            $("powerups").append(chip);
        });
    }

    function selectWeapon(index) {
        if (state.reloadLeft > 0) return;

        state.selected = index;

        weaponMeshes.forEach((mesh, current) => {
            mesh.visible = current === index;
        });

        document.querySelectorAll(".weapon-slot").forEach((slot, current) => {
            slot.classList.toggle("active", current === index);
        });

        updateHUD();
    }

    function resetWeapons() {
        weapons = weaponDefinitions.map(weapon => ({
            ...weapon,
            clip: weapon.size,
            ammo: weapon.reserve
        }));

        $("weapon-slots").replaceChildren();

        weapons.forEach((weapon, index) => {
            const slot = document.createElement("div");
            const number = document.createElement("b");
            const name = document.createElement("small");

            slot.className = "weapon-slot";
            number.textContent = index + 1;
            name.textContent = weapon.short;

            slot.append(number, name);
            $("weapon-slots").append(slot);
        });

        selectWeapon(0);
    }

    function startWave(number) {
        state.wave = number;

        state.spawnLeft = Math.round(
            (6 + number * 4) * difficulties[state.difficulty].count
        );

        state.spawnTimer = 0;
        state.waveTimer = 0;

        banner(`NOITE ${number} — A HORDA ESTÁ CHEGANDO`);
        audio.tone(95, 45, .7, "sawtooth", .18);
    }

    function resetGame() {
        [enemies, projectiles, particles, pickups].forEach(clearTransient);

        Object.assign(state, {
            health: 100,
            shield: 100,
            stamina: 100,
            score: 0,
            kills: 0,
            headshots: 0,
            elapsed: 0,
            wave: 1,
            selected: 0,
            combo: 0,
            comboUntil: 0,
            spawnLeft: 0,
            spawnTimer: 0,
            waveTimer: 0,
            cooldown: 0,
            reloadLeft: 0,
            lastDamage: -100,
            damageUntil: 0,
            speedUntil: 0,
            slowUntil: 0,
            noticeUntil: 0,
            bannerUntil: 0,
            hitUntil: 0,
            flashUntil: 0,
            feet: 0,
            verticalSpeed: 0,
            flashlight: false,
            exhausted: false,
            result: null,
            saving: false
        });

        player.position.set(0, 1.7, 0);
        player.rotation.set(0, 0, 0);
        pitch.rotation.set(0, 0, 0);
        camera.position.set(0, 0, 0);

        flashlight.intensity = 0;
        muzzle.intensity = 0;
        recoil = 0;
        shakeAmount = 0;
        shooting = false;

        keys.clear();

        lootBoxes.forEach(loot => {
            loot.used = false;
            loot.marker.visible = true;
            loot.body.material.color.setHex(0x526444);
            loot.lid.material.color.setHex(0x7a965d);
        });

        $("notice").textContent = "";
        $("interaction").textContent = "";
        $("score-popups").replaceChildren();
        $("retry-save").hidden = true;
        $("damage-overlay").style.opacity = 0;
        $("damage-overlay").classList.remove("critical");
        $("hitmarker").style.opacity = 0;

        resetWeapons();
        startWave(1);
        updateHUD();
        drawMinimap();
    }

    function captureMouse() {
        try {
            const canvas = $("game-canvas");

            if (!canvas.requestPointerLock) {
                throw new Error(
                    "Este navegador não oferece captura do mouse."
                );
            }

            const result = canvas.requestPointerLock();

            if (result && result.catch) {
                result.catch(() => {
                    showError(
                        "Clique em CONTINUAR para capturar o mouse. " +
                        "Se estiver em uma prévia, abra o jogo em outra aba."
                    );
                });
            }
        } catch (error) {
            showError(error.message);
        }
    }

    function newGame() {
        try {
            $("global-error").hidden = true;

            initializeWorld();
            audio.init();

            state.difficulty = $("difficulty").value;
            resetGame();

            state.matchPromise = api("/api/matches", "POST", {
                difficulty: state.difficulty
            }).then(data => data.id).catch(error => {
                showError("Partida sem ranking: " + error.message);
                return null;
            });

            state.mode = "paused";
            showScreen("pause");
            captureMouse();
        } catch (error) {
            openMenu();
            showError("Não foi possível iniciar o jogo: " + error.message);
        }
    }

    function pauseGame() {
        if (state.mode !== "playing") return;

        state.mode = "paused";
        shooting = false;
        keys.clear();

        showScreen("pause");
    }

    async function saveResult() {
        if (!state.result || state.saving) return;

        const result = state.result;
        const matchPromise = state.matchPromise;

        state.saving = true;
        $("retry-save").hidden = true;
        $("save-status").textContent = "Salvando pontuação...";

        try {
            const matchId = await matchPromise;

            if (!matchId) {
                throw new Error(
                    "Esta partida não foi registrada no servidor."
                );
            }

            await api(
                `/api/matches/${encodeURIComponent(matchId)}/finish`,
                "POST",
                result
            );

            if (state.result === result) {
                $("save-status").textContent = "Pontuação salva.";
            }
        } catch (error) {
            if (state.result === result) {
                $("save-status").textContent = error.message;
                $("retry-save").hidden = false;
            }
        } finally {
            if (state.result === result) state.saving = false;
        }
    }

    function finishGame(abandoned = false) {
        if (state.mode === "over") return;

        state.mode = "over";
        shooting = false;
        keys.clear();

        if (document.pointerLockElement) {
            document.exitPointerLock();
        }

        state.result = {
            score: state.score,
            wave: state.wave,
            kills: state.kills,
            headshots: state.headshots,
            seconds: Math.round(state.elapsed * 100) / 100
        };

        $("over-title").textContent = abandoned
            ? "OPERAÇÃO ENCERRADA"
            : "VOCÊ FOI DEVORADO";

        $("results").replaceChildren();

        [
            ["PONTOS", state.score],
            ["ONDA", state.wave],
            ["ABATES", state.kills],
            ["HEADSHOTS", state.headshots],
            ["TEMPO", formatTime(state.elapsed)],
            ["DIFICULDADE", {
                easy: "FÁCIL",
                normal: "NORMAL",
                hard: "DIFÍCIL"
            }[state.difficulty]]
        ].forEach(([label, value]) => {
            const item = document.createElement("div");
            const title = document.createElement("small");
            const number = document.createElement("strong");

            item.className = "result";
            title.textContent = label;
            number.textContent = value;

            item.append(title, number);
            $("results").append(item);
        });

        showScreen("over");
        saveResult();
    }

    function reloadWeapon() {
        const weapon = weapons[state.selected];

        if (state.reloadLeft > 0 || weapon.clip === weapon.size) return;

        if (weapon.ammo <= 0) {
            notice("SEM RESERVA — PROCURE SUPRIMENTOS");
            return;
        }

        state.reloadLeft = weapon.reload;
        audio.tone(300, 220, .1, "square", .12);
    }

    function nearestLoot() {
        let selected = null;
        let nearest = 3.2;

        for (const loot of lootBoxes) {
            if (loot.used) continue;

            const distance = Math.hypot(
                loot.mesh.position.x - player.position.x,
                loot.mesh.position.z - player.position.z
            );

            if (distance >= nearest) continue;

            const target = loot.mesh.position.clone();
            target.y = .8;

            if (lineBlocked(player.position, target)) continue;

            nearest = distance;
            selected = loot;
        }

        return selected;
    }

    function collectLoot() {
        const loot = nearestLoot();
        if (!loot) return;

        loot.used = true;
        loot.marker.visible = false;
        loot.body.material.color.setHex(0x33383a);
        loot.lid.material.color.setHex(0x33383a);

        if (loot.type === "ammo") {
            const weapon = weapons[state.selected];
            const amount = Math.round(weapon.size * 2.5);

            weapon.ammo += amount;
            notice(`+${amount} MUNIÇÕES — ${weapon.short}`);
        } else if (loot.type === "health") {
            state.health = Math.min(100, state.health + 35);
            state.shield = Math.min(100, state.shield + 25);

            notice("VIDA E COLETE RECUPERADOS");
        } else {
            weapons.forEach(weapon => weapon.ammo += weapon.size * 2);
            state.damageUntil = state.elapsed + 15;

            notice("ARSENAL REABASTECIDO · DANO EXTRA");
        }

        audio.tone(600, 1200, .2);
        updateHUD();
    }

    function sparks(position, color, count = 8) {
        if (!settings.effects || !settings.particles) return;

        const limit = settings.quality === "low" ? 45 : 120;

        for (
            let index = 0;
            index < count && particles.length < limit;
            index++
        ) {
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(.07, .07, .07),
                new THREE.MeshBasicMaterial({ color })
            );

            mesh.position.copy(position);
            scene.add(mesh);

            particles.push({
                mesh,
                velocity: new THREE.Vector3(
                    random(-3, 3),
                    random(1, 5),
                    random(-3, 3)
                ),
                life: random(.2, .5)
            });
        }
    }

    function tracer(start, end, color) {
        if (!settings.effects) return;

        const mesh = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([start, end]),
            new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity: .7
            })
        );

        scene.add(mesh);

        particles.push({
            mesh,
            velocity: new THREE.Vector3(),
            life: .045,
            tracer: true
        });
    }

    function scorePopup(point, text) {
        const position = point.clone().project(camera);

        if (position.z > 1 || position.z < -1) return;

        const element = document.createElement("div");
        element.className = "score-popup";
        element.textContent = text;

        element.style.left = `${(position.x + 1) * innerWidth / 2}px`;
        element.style.top = `${(1 - position.y) * innerHeight / 2}px`;

        $("score-popups").append(element);

        element.addEventListener(
            "animationend",
            () => element.remove(),
            { once: true }
        );
    }

    function getEnemy(object) {
        let current = object;

        while (current) {
            if (current.userData.enemy) return current.userData.enemy;
            current = current.parent;
        }

        return null;
    }

    function hitEnemy(enemy, damage, headshot, point) {
        if (enemy.dead) return;

        enemy.health -= damage;
        state.hitUntil = state.elapsed + .12;

        $("hitmarker").style.opacity = 1;
        $("hitmarker").style.color = headshot ? "#ffcf77" : "#7affba";

        audio.tone(headshot ? 1700 : 1100, 500, .06, "sine", .08);
        sparks(point, headshot ? 0xffcc66 : 0xaa4466);

        if (enemy.health > 0) return;

        enemy.dead = true;

        state.combo =
            state.elapsed < state.comboUntil ? state.combo + 1 : 1;

        state.comboUntil = state.elapsed + 3;

        const base = Math.round(
            100 * state.wave * enemy.definition.points
        );

        const comboBonus = state.combo > 1
            ? Math.round(base * .15 * Math.min(state.combo, 8))
            : 0;

        const points = base + comboBonus + (headshot ? 50 : 0);

        state.score += points;
        state.kills++;

        if (headshot) state.headshots++;

        scorePopup(point, `${headshot ? "HEADSHOT " : ""}+${points}`);

        const position = enemy.mesh.position.clone();
        const index = enemies.indexOf(enemy);

        if (index !== -1) enemies.splice(index, 1);

        disposeObject(enemy.mesh);

        if (Math.random() < .22) createPickup(position);
    }

    function fireWeapon() {
        if (
            state.mode !== "playing" ||
            state.reloadLeft > 0 ||
            state.cooldown > 0
        ) return;

        const weapon = weapons[state.selected];

        if (weapon.clip <= 0) {
            if (weapon.ammo > 0) {
                reloadWeapon();
            } else {
                notice("SEM MUNIÇÃO — TROQUE DE ARMA");
                state.cooldown = .4;
            }

            return;
        }

        weapon.clip--;
        state.cooldown = weapon.delay;

        recoil = state.selected === 1 ? .13 : .04;
        muzzle.color.setHex(weapon.color);
        muzzle.intensity = settings.effects ? 2 : 0;

        audio.tone(
            [500, 220, 420, 900][state.selected],
            [60, 25, 80, 180][state.selected],
            [.14, .27, .09, .25][state.selected],
            ["triangle", "sawtooth", "square", "sine"][state.selected],
            .22
        );

        scene.updateMatrixWorld(true);

        const origin = camera.getWorldPosition(new THREE.Vector3());
        const rotation = camera.getWorldQuaternion(new THREE.Quaternion());
        const multiplier = state.damageUntil > state.elapsed ? 1.6 : 1;

        if (state.selected === 3) {
            const direction = new THREE.Vector3(
                0, 0, -1
            ).applyQuaternion(rotation);

            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(.2, 8, 8),
                new THREE.MeshBasicMaterial({ color: 0xbb66ff })
            );

            mesh.position.copy(origin);
            scene.add(mesh);

            projectiles.push({
                mesh,
                direction,
                damage: weapon.damage * multiplier,
                life: 3
            });
        } else {
            const ray = new THREE.Raycaster();

            for (let pellet = 0; pellet < weapon.pellets; pellet++) {
                const direction = new THREE.Vector3(
                    random(-weapon.spread, weapon.spread),
                    random(-weapon.spread, weapon.spread),
                    -1
                ).normalize().applyQuaternion(rotation);

                ray.set(origin, direction);
                ray.far = 160;

                const hits = ray.intersectObjects(
                    rayTargets.concat(enemies.map(enemy => enemy.mesh)),
                    true
                );

                let endpoint = origin.clone().addScaledVector(
                    direction, 150
                );

                if (hits.length) {
                    const hit = hits[0];
                    endpoint = hit.point;

                    const enemy = getEnemy(hit.object);

                    if (enemy) {
                        const headshot = Boolean(hit.object.userData.head);

                        hitEnemy(
                            enemy,
                            weapon.damage * multiplier *
                                (headshot ? 2.2 : 1),
                            headshot,
                            endpoint
                        );
                    } else {
                        sparks(endpoint, 0xaaaaaa, 4);
                    }
                }

                tracer(origin, endpoint, weapon.color);
            }
        }

        updateHUD();
    }

    function chooseEnemyType() {
        const roll = Math.random();

        if (state.wave >= 6 && roll < .12) return "special";
        if (state.wave >= 3 && roll < .3) return "tank";
        if (state.wave >= 2 && roll < .55) return "fast";

        return "common";
    }

    function createEnemy(x, z) {
        const type = chooseEnemyType();
        const definition = enemyDefinitions[type];
        const difficulty = difficulties[state.difficulty];

        const mesh = new THREE.Group();
        mesh.position.set(x, 0, z);
        mesh.scale.setScalar(definition.scale);
        scene.add(mesh);

        box(mesh, .8, 1, .45, 0, 1.15, 0, 0x2c3845);

        const head = box(
            mesh, .5, .55, .5,
            0, 1.9, 0,
            definition.color
        );

        head.userData.head = true;

        const leftArm = box(
            mesh, .22, .8, .23,
            -.52, 1.3, .3,
            definition.color
        );

        const rightArm = box(
            mesh, .22, .8, .23,
            .52, 1.3, .3,
            definition.color
        );

        leftArm.rotation.x = -1;
        rightArm.rotation.x = -1;

        const leftLeg = box(
            mesh, .27, .8, .28, -.22, .4, 0, 0x252c35
        );

        const rightLeg = box(
            mesh, .27, .8, .28, .22, .4, 0, 0x252c35
        );

        for (const eyeX of [-.12, .12]) {
            const eye = box(
                mesh, .1, .07, .06,
                eyeX, 1.95, .27,
                0xff3344,
                {
                    emissive: type === "special" ? 0x44ff99 : 0xff2233,
                    emissiveIntensity: 2
                }
            );

            eye.userData.head = true;
        }

        const enemy = {
            mesh,
            definition,
            type,
            legs: [leftLeg, rightLeg],
            health:
                (definition.hp + state.wave * definition.growth) *
                difficulty.health,
            speed:
                (definition.speed + Math.min(2, state.wave * .1)) *
                difficulty.speed,
            damage: definition.damage * difficulty.damage,
            cooldown: random(.1, .6),
            phase: random(0, 6),
            side: Math.random() < .5 ? -1 : 1,
            dead: false
        };

        mesh.userData.enemy = enemy;
        enemies.push(enemy);
    }

    function spawnEnemy() {
        const roads = [-80, -40, 0, 40, 80];

        for (let attempt = 0; attempt < 30; attempt++) {
            const side = Math.floor(Math.random() * 4);
            const road = roads[Math.floor(Math.random() * roads.length)];

            const x = side < 2 ? (side === 0 ? -84 : 84) : road;
            const z = side >= 2 ? (side === 2 ? -84 : 84) : road;

            if (
                Math.hypot(
                    x - player.position.x,
                    z - player.position.z
                ) > 20 &&
                !blocked(x, z, .8)
            ) {
                createEnemy(x, z);
                state.spawnLeft--;
                return;
            }
        }
    }

    function damagePlayer(amount) {
        if (state.mode !== "playing") return;

        const absorbed = Math.min(state.shield, amount);
        state.shield -= absorbed;
        state.health = Math.max(0, state.health - amount + absorbed);
        state.lastDamage = state.elapsed;
        state.flashUntil = state.elapsed + .3;

        if (settings.shake) shakeAmount = .1;

        audio.tone(80, 35, .3, "sawtooth", .13);

        if (state.health <= 0) finishGame();
    }

    function updateEnemies(delta) {
        for (const enemy of [...enemies]) {
            if (state.mode !== "playing") break;

            enemy.cooldown -= delta;
            enemy.phase += delta * enemy.speed * 2;

            enemy.legs[0].rotation.x = Math.sin(enemy.phase) * .6;
            enemy.legs[1].rotation.x = -Math.sin(enemy.phase) * .6;

            const dx = player.position.x - enemy.mesh.position.x;
            const dz = player.position.z - enemy.mesh.position.z;
            const distance = Math.hypot(dx, dz);
            const angle = Math.atan2(dx, dz);

            enemy.mesh.rotation.y = angle;

            const origin = enemy.mesh.position.clone();
            origin.y = 1.4 * enemy.definition.scale;

            if (
                distance < 1.4 * enemy.definition.scale + .4 &&
                state.feet < 1.7 * enemy.definition.scale &&
                !lineBlocked(origin, player.position)
            ) {
                if (enemy.cooldown <= 0) {
                    enemy.cooldown = .85;
                    damagePlayer(enemy.damage);
                }

                continue;
            }

            if (distance < .05) continue;

            const charge =
                enemy.type === "special" &&
                state.elapsed % 4 < .7 &&
                distance < 25;

            const step = enemy.speed * delta * (charge ? 1.6 : 1);
            const radius = .42 * enemy.definition.scale;

            const directions = [
                0,
                .55 * enemy.side,
                1.1 * enemy.side,
                1.6 * enemy.side,
                -.55 * enemy.side,
                -1.1 * enemy.side,
                -1.6 * enemy.side,
                Math.PI
            ];

            for (const offset of directions) {
                const nx =
                    enemy.mesh.position.x + Math.sin(angle + offset) * step;

                const nz =
                    enemy.mesh.position.z + Math.cos(angle + offset) * step;

                if (!blocked(
                    nx, nz, radius, 0, 2.2 * enemy.definition.scale
                )) {
                    enemy.mesh.position.x = nx;
                    enemy.mesh.position.z = nz;
                    break;
                }
            }
        }
    }

    function createPickup(position) {
        const definition = pickupDefinitions[
            Math.floor(Math.random() * pickupDefinitions.length)
        ];

        const mesh = new THREE.Mesh(
            new THREE.OctahedronGeometry(.36),
            material(definition[1], {
                emissive: definition[1],
                emissiveIntensity: .9
            })
        );

        mesh.position.copy(position);
        mesh.position.y = 1;
        scene.add(mesh);

        pickups.push({ mesh, definition, life: 22 });
    }

    function updatePickups(delta) {
        for (let index = pickups.length - 1; index >= 0; index--) {
            const pickup = pickups[index];

            pickup.life -= delta;
            pickup.mesh.rotation.y += delta * 2;

            pickup.mesh.position.y =
                1 + Math.sin(state.elapsed * 3 + index) * .15;

            const near =
                pickup.mesh.position.distanceTo(player.position) < 1.8 &&
                !lineBlocked(player.position, pickup.mesh.position);

            if (near) {
                const type = pickup.definition[0];

                if (type === "health") {
                    state.health = Math.min(100, state.health + 40);
                }

                if (type === "shield") {
                    state.shield = Math.min(100, state.shield + 40);
                }

                if (type === "ammo") {
                    weapons.forEach(weapon => weapon.ammo += weapon.size * 2);
                }

                if (type === "damage") {
                    state.damageUntil = state.elapsed + 12;
                }

                if (type === "speed") {
                    state.speedUntil = state.elapsed + 12;
                }

                if (type === "slow") {
                    state.slowUntil = state.elapsed + 6;
                }

                notice(pickup.definition[2]);
                audio.tone(600, 1200, .2);
            }

            if (near || pickup.life <= 0) {
                disposeObject(pickup.mesh);
                pickups.splice(index, 1);
            }
        }
    }

    function updateProjectiles(delta) {
        scene.updateMatrixWorld(true);

        for (let index = projectiles.length - 1; index >= 0; index--) {
            const projectile = projectiles[index];
            const travel = 45 * delta;

            const ray = new THREE.Raycaster(
                projectile.mesh.position.clone(),
                projectile.direction,
                0,
                travel + .2
            );

            const hits = ray.intersectObjects(
                rayTargets.concat(enemies.map(enemy => enemy.mesh)),
                true
            );

            projectile.mesh.position.addScaledVector(
                projectile.direction, travel
            );

            projectile.life -= delta;

            if (hits.length) {
                projectile.mesh.position.copy(hits[0].point);
            }

            if (
                hits.length ||
                projectile.mesh.position.y <= .1 ||
                projectile.life <= 0
            ) {
                const center = projectile.mesh.position.clone();

                sparks(center, 0xbb66ff, 20);
                audio.tone(150, 20, .4, "sawtooth", .25);

                for (const enemy of [...enemies]) {
                    const target = enemy.mesh.position.clone();
                    target.y = 1;

                    const distance = center.distanceTo(target);

                    if (distance < 6) {
                        hitEnemy(
                            enemy,
                            projectile.damage * (1 - distance / 9),
                            false,
                            target
                        );
                    }
                }

                disposeObject(projectile.mesh);
                projectiles.splice(index, 1);
            }
        }
    }

    function updateParticles(delta) {
        for (let index = particles.length - 1; index >= 0; index--) {
            const particle = particles[index];
            particle.life -= delta;

            if (!particle.tracer) {
                particle.mesh.position.addScaledVector(
                    particle.velocity, delta
                );

                particle.velocity.y -= delta * 10;
            }

            if (particle.life <= 0) {
                disposeObject(particle.mesh);
                particles.splice(index, 1);
            }
        }
    }

    function updatePlayer(delta) {
        const input = new THREE.Vector3(
            Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
            0,
            Number(keys.has("KeyS")) - Number(keys.has("KeyW"))
        );

        const moving = input.lengthSq() > 0;
        const sprintHeld =
            keys.has("ShiftLeft") || keys.has("ShiftRight");

        if (state.stamina <= 1) state.exhausted = true;
        if (!sprintHeld || state.stamina >= 30) state.exhausted = false;

        const running =
            moving && sprintHeld && !state.exhausted && state.stamina > 1;

        state.stamina = clamp(
            state.stamina + (running ? -26 : 18) * delta,
            0,
            100
        );

        const speed =
            (running ? 12.5 : 7.5) *
            (state.speedUntil > state.elapsed ? 1.5 : 1);

        input.normalize().applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            player.rotation.y
        );

        const nx = player.position.x + input.x * speed * delta;
        const nz = player.position.z + input.z * speed * delta;

        if (!blocked(nx, player.position.z, .5, state.feet)) {
            player.position.x = nx;
        }

        if (!blocked(player.position.x, nz, .5, state.feet)) {
            player.position.z = nz;
        }

        state.verticalSpeed -= 19 * delta;

        const nextFeet = Math.max(
            0,
            state.feet + state.verticalSpeed * delta
        );

        if (
            nextFeet > state.feet &&
            blocked(player.position.x, player.position.z, .45, nextFeet)
        ) {
            state.verticalSpeed = 0;
        } else {
            state.feet = nextFeet;
        }

        if (state.feet === 0) state.verticalSpeed = 0;

        player.position.y = 1.7 + state.feet;

        if (state.elapsed - state.lastDamage > 6) {
            state.shield = Math.min(100, state.shield + delta * 5);
        }

        if (state.reloadLeft > 0) {
            state.reloadLeft -= delta;

            if (state.reloadLeft <= 0) {
                state.reloadLeft = 0;

                const weapon = weapons[state.selected];
                const amount = Math.min(
                    weapon.size - weapon.clip,
                    weapon.ammo
                );

                weapon.clip += amount;
                weapon.ammo -= amount;
            }
        }

        recoil = Math.max(0, recoil - delta * .6);
        muzzle.intensity = Math.max(0, muzzle.intensity - delta * 50);

        const model = weaponMeshes[state.selected];

        model.position.z = -.5 + recoil;

        model.position.y = -.25 +
            (moving
                ? Math.sin(state.elapsed * (running ? 14 : 9)) * .018
                : 0);

        model.rotation.x =
            recoil * 1.3 + (state.reloadLeft > 0 ? -.45 : 0);

        if (shakeAmount > 0 && settings.shake) {
            shakeAmount = Math.max(0, shakeAmount - delta * .5);

            camera.position.set(
                random(-shakeAmount, shakeAmount),
                random(-shakeAmount, shakeAmount),
                0
            );
        } else {
            camera.position.set(0, 0, 0);
        }

        $("interaction").textContent =
            nearestLoot() ? "[ E ] COLETAR SUPRIMENTOS" : "";
    }

    function drawMinimap() {
        if (!settings.showMap || !player) return;

        const context = $("minimap").getContext("2d");
        const convert = value => value * 170 / 190 + 85;

        context.fillStyle = "#0c111b";
        context.fillRect(0, 0, 170, 170);

        context.strokeStyle = "#293448";
        context.lineWidth = 6;

        for (const value of [-80, -40, 0, 40, 80]) {
            context.beginPath();
            context.moveTo(convert(value), 0);
            context.lineTo(convert(value), 170);
            context.moveTo(0, convert(value));
            context.lineTo(170, convert(value));
            context.stroke();
        }

        context.fillStyle = "#76edb6";

        lootBoxes.forEach(loot => {
            if (!loot.used) {
                context.fillRect(
                    convert(loot.mesh.position.x) - 1,
                    convert(loot.mesh.position.z) - 1,
                    2, 2
                );
            }
        });

        context.fillStyle = "#ff6077";

        enemies.forEach(enemy => {
            context.beginPath();

            context.arc(
                convert(enemy.mesh.position.x),
                convert(enemy.mesh.position.z),
                enemy.type === "tank" ? 2.7 : 1.8,
                0,
                Math.PI * 2
            );

            context.fill();
        });

        context.save();
        context.translate(
            convert(player.position.x),
            convert(player.position.z)
        );

        context.rotate(-player.rotation.y);
        context.fillStyle = "white";
        context.beginPath();
        context.moveTo(0, -6);
        context.lineTo(-4, 4);
        context.lineTo(4, 4);
        context.closePath();
        context.fill();
        context.restore();
    }

    function updateGame(delta) {
        state.elapsed += delta;
        state.cooldown = Math.max(0, state.cooldown - delta);

        updatePlayer(delta);

        if (shooting && weapons[state.selected].automatic) {
            fireWeapon();
        }

        updateEnemies(
            delta * (state.slowUntil > state.elapsed ? .35 : 1)
        );

        if (state.mode !== "playing") return;

        updateProjectiles(delta);
        updatePickups(delta);
        updateParticles(delta);

        if (state.waveTimer > 0) {
            state.waveTimer -= delta;

            if (state.waveTimer <= 0) {
                startWave(state.wave + 1);
            }
        } else {
            state.spawnTimer += delta;

            if (
                state.spawnLeft > 0 &&
                state.spawnTimer >= .85 &&
                enemies.length < 45
            ) {
                state.spawnTimer = 0;
                spawnEnemy();
            }

            if (state.spawnLeft === 0 && enemies.length === 0) {
                const bonus = state.wave * 250;

                state.score += bonus;
                state.health = Math.min(100, state.health + 15);
                state.shield = Math.min(100, state.shield + 40);
                state.waveTimer = 3.5;

                banner(`ÁREA LIMPA · +${bonus} PONTOS`, 3);
            }
        }

        if (state.elapsed >= state.noticeUntil) {
            $("notice").textContent = "";
        }

        if (state.elapsed >= state.bannerUntil) {
            $("wave-banner").textContent = "";
        }

        if (state.elapsed >= state.hitUntil) {
            $("hitmarker").style.opacity = 0;
        }

        $("damage-overlay").style.opacity =
            settings.effects && state.elapsed < state.flashUntil
                ? .6
                : 0;

        lamps.forEach(lamp => {
            lamp.phase += delta;
            lamp.light.intensity =
                Math.sin(lamp.phase * 15) > .96 ? .15 : .8;
        });

        lootBoxes.forEach(loot => {
            if (!loot.used) loot.marker.rotation.y += delta;
        });

        hudTimer += delta;

        if (hudTimer >= .12) {
            hudTimer = 0;
            updateHUD();
            drawMinimap();
        }
    }

    $("profile-form").addEventListener("submit", async event => {
        event.preventDefault();

        const button = event.currentTarget.querySelector("button");

        $("profile-error").textContent = "";
        $("global-error").hidden = true;

        if (bootstrapError) {
            $("profile-error").textContent = bootstrapError;
            return;
        }

        button.disabled = true;

        const originalText = button.textContent;
        button.textContent = "ACESSANDO...";

        try {
            const data = await api("/api/profile", "POST", {
                nickname: $("nickname").value.trim()
            });

            state.nickname = data.nickname;
            openMenu();
        } catch (error) {
            $("profile-error").textContent = error.message;
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    });

    $("play-button").onclick = newGame;
    $("retry-button").onclick = newGame;

    $("resume-button").onclick = () => {
        audio.init();
        captureMouse();
    };

    $("quit-button").onclick = () => finishGame(true);
    $("over-menu").onclick = openMenu;
    $("retry-save").onclick = saveResult;

    $("change-name").onclick = () => {
        state.mode = "profile";
        $("nickname").value = state.nickname;
        showScreen("profile");
    };

    $("help-button").onclick = () => {
        returnScreen = "menu";
        showScreen("help");
    };

    $("pause-help").onclick = () => {
        returnScreen = "pause";
        showScreen("help");
    };

    $("help-back").onclick = () => showScreen(returnScreen);

    const settingIds = {
        volume: "volume",
        sfx: "sfx",
        sensitivity: "sensitivity",
        quality: "quality",
        sound: "sound",
        effects: "effects",
        particles: "particles",
        shake: "shake",
        showMap: "show-map"
    };

    function syncSettings() {
        Object.entries(settingIds).forEach(([key, id]) => {
            const element = $(id);

            if (element.type === "checkbox") {
                element.checked = settings[key];
            } else {
                element.value = settings[key];
            }
        });

        for (const key of ["volume", "sfx", "sensitivity"]) {
            $(`${key}-label`).textContent = `${settings[key]}%`;
        }
    }

    function openSettings(from) {
        returnScreen = from;
        syncSettings();
        showScreen("settings");
    }

    $("settings-button").onclick = () => openSettings("menu");
    $("pause-settings").onclick = () => openSettings("pause");

    Object.entries(settingIds).forEach(([key, id]) => {
        $(id).addEventListener("input", event => {
            const element = event.target;

            settings[key] = element.type === "checkbox"
                ? element.checked
                : element.type === "range"
                    ? Number(element.value)
                    : element.value;

            if (["volume", "sfx", "sensitivity"].includes(key)) {
                $(`${key}-label`).textContent = `${settings[key]}%`;
            }

            applySettings();
        });
    });

    $("settings-back").onclick = () => {
        try {
            localStorage.setItem(
                "deadzone_settings_v4",
                JSON.stringify(settings)
            );
        } catch (_) {}

        showScreen(returnScreen);
    };

    let rankingRequest = 0;

    async function loadRanking() {
        const requestId = ++rankingRequest;

        $("ranking-body").replaceChildren();
        $("ranking-status").textContent = "Carregando...";

        try {
            const data = await api(
                "/api/ranking?difficulty=" +
                encodeURIComponent($("ranking-difficulty").value)
            );

            if (requestId !== rankingRequest) return;

            $("ranking-status").textContent = data.ranking.length
                ? "Melhores 15 partidas."
                : "Ainda não há pontuações.";

            data.ranking.forEach((entry, index) => {
                const row = document.createElement("tr");

                [
                    index + 1,
                    entry.nickname,
                    entry.score,
                    entry.wave,
                    entry.kills,
                    formatTime(entry.seconds)
                ].forEach(value => {
                    const cell = document.createElement("td");
                    cell.textContent = value;
                    row.append(cell);
                });

                $("ranking-body").append(row);
            });
        } catch (error) {
            if (requestId === rankingRequest) {
                $("ranking-status").textContent = error.message;
            }
        }
    }

    $("ranking-button").onclick = () => {
        $("ranking-difficulty").value = $("difficulty").value;
        showScreen("ranking");
        loadRanking();
    };

    $("ranking-difficulty").onchange = loadRanking;
    $("ranking-back").onclick = () => showScreen("menu");

    document.addEventListener("pointerlockchange", () => {
        if (document.pointerLockElement === $("game-canvas")) {
            if (state.mode !== "paused") {
                document.exitPointerLock();
                return;
            }

            state.mode = "playing";
            showScreen("playing");
        } else {
            pauseGame();
        }
    });

    document.addEventListener("pointerlockerror", () => {
        showError(
            "O navegador bloqueou a captura do mouse. " +
            "Abra o jogo em uma aba própria e clique em CONTINUAR."
        );
    });

    document.addEventListener("mousemove", event => {
        if (
            state.mode !== "playing" ||
            document.pointerLockElement !== $("game-canvas")
        ) return;

        const sensitivity = .0007 + settings.sensitivity * .000035;

        player.rotation.y -= event.movementX * sensitivity;

        pitch.rotation.x = clamp(
            pitch.rotation.x - event.movementY * sensitivity,
            -Math.PI / 2 + .05,
            Math.PI / 2 - .05
        );
    });

    window.addEventListener("keydown", event => {
        if (state.mode !== "playing") return;

        if (event.code === "Space") event.preventDefault();

        keys.add(event.code);

        if (event.repeat) return;

        if (/^Digit[1-4]$/.test(event.code)) {
            selectWeapon(Number(event.code.slice(-1)) - 1);
        }

        if (event.code === "KeyR") reloadWeapon();
        if (event.code === "KeyE") collectLoot();

        if (event.code === "KeyF") {
            state.flashlight = !state.flashlight;
            flashlight.intensity = state.flashlight ? 2.5 : 0;
            updateHUD();
        }

        if (
            event.code === "Space" &&
            state.feet === 0 &&
            state.stamina >= 12
        ) {
            state.verticalSpeed = 7;
            state.stamina -= 12;
        }
    });

    window.addEventListener("keyup", event => keys.delete(event.code));

    window.addEventListener("mousedown", event => {
        if (
            event.button !== 0 ||
            state.mode !== "playing" ||
            document.pointerLockElement !== $("game-canvas")
        ) return;

        shooting = true;
        fireWeapon();
    });

    window.addEventListener("mouseup", event => {
        if (event.button === 0) shooting = false;
    });

    window.addEventListener("wheel", event => {
        if (state.mode !== "playing") return;

        event.preventDefault();

        selectWeapon(
            (state.selected + (event.deltaY > 0 ? 1 : 3)) % 4
        );
    }, { passive: false });

    function loseFocus() {
        keys.clear();
        shooting = false;

        if (document.pointerLockElement === $("game-canvas")) {
            document.exitPointerLock();
        }

        pauseGame();
    }

    window.addEventListener("blur", loseFocus);

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) loseFocus();
    });

    function editorGeometry(type) {
        if (type === "cylinder") {
            return new THREE.CylinderGeometry(1, 1, 3, 16);
        }

        if (type === "sphere") {
            return new THREE.SphereGeometry(1.25, 20, 16);
        }

        if (type === "cone") {
            return new THREE.ConeGeometry(1.4, 3, 16);
        }

        return new THREE.BoxGeometry(2.5, 2.5, 2.5);
    }

    function rebuildPreview() {
        if (!editorScene) return;

        if (editorMesh) disposeObject(editorMesh);

        editorMesh = new THREE.Mesh(
            editorGeometry($("object-type").value),
            material($("object-color").value, {
                roughness: Number($("object-roughness").value),
                metalness: .35
            })
        );

        editorMesh.scale.setScalar(Number($("object-scale").value));
        editorScene.add(editorMesh);
    }

    function resizeEditor() {
        if (!editorRenderer || currentScreen !== "editor") return;

        const area = $("editor-canvas").parentElement;
        const width = Math.max(1, area.clientWidth);
        const height = Math.max(1, area.clientHeight);

        editorRenderer.setSize(width, height, false);
        editorCamera.aspect = width / height;
        editorCamera.updateProjectionMatrix();
    }

    $("editor-button").onclick = () => {
        try {
            initializeWorld();
            showScreen("editor");

            if (!editorRenderer) {
                editorRenderer = new THREE.WebGLRenderer({
                    canvas: $("editor-canvas"),
                    antialias: true
                });

                editorRenderer.setPixelRatio(
                    Math.min(devicePixelRatio || 1, 1.5)
                );

                editorScene = new THREE.Scene();
                editorScene.background = new THREE.Color(0x101521);

                editorCamera = new THREE.PerspectiveCamera(
                    45, 1, .1, 50
                );

                editorCamera.position.set(5, 4, 7);
                editorCamera.lookAt(0, 0, 0);

                editorScene.add(
                    new THREE.HemisphereLight(0xffffff, 0x343047, 1)
                );

                const light = new THREE.DirectionalLight(0xffdfc7, 1);
                light.position.set(4, 7, 5);
                editorScene.add(light);

                editorScene.add(
                    new THREE.GridHelper(12, 12, 0x484354, 0x252a39)
                );
            }

            rebuildPreview();
            resizeEditor();
        } catch (error) {
            showScreen("menu");
            showError("Erro ao abrir o editor: " + error.message);
        }
    };

    for (const id of [
        "object-type",
        "object-color",
        "object-roughness",
        "object-scale"
    ]) {
        $(id).addEventListener("input", rebuildPreview);
    }

    $("insert-object").onclick = () => {
        if (!editorMesh) return;

        if (customObjects.length >= 20) {
            $("editor-status").textContent =
                "Limite de 20 objetos atingido.";
            return;
        }

        const scale = Number($("object-scale").value);
        const radius = 1.5 * scale;
        let position = null;

        for (let attempt = 0; attempt < 100; attempt++) {
            const x = random(-70, 70);
            const z = random(-70, 70);

            const nearLoot = lootBoxes.some(loot => {
                return Math.hypot(
                    x - loot.mesh.position.x,
                    z - loot.mesh.position.z
                ) < radius + 5;
            });

            if (
                Math.hypot(x, z) > 12 &&
                !blocked(x, z, radius + 1, 0, 8) &&
                !nearLoot
            ) {
                position = new THREE.Vector3(x, 0, z);
                break;
            }
        }

        if (!position) {
            $("editor-status").textContent =
                "Não foi encontrado espaço livre.";
            return;
        }

        const mesh = new THREE.Mesh(
            editorGeometry($("object-type").value),
            material($("object-color").value, {
                roughness: Number($("object-roughness").value),
                metalness: .35
            })
        );

        mesh.scale.setScalar(scale);
        mesh.geometry.computeBoundingBox();

        position.y = -mesh.geometry.boundingBox.min.y * scale;

        mesh.position.copy(position);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        scene.add(mesh);

        customObjects.push({
            mesh,
            collision: addCollision(mesh)
        });

        $("editor-status").textContent =
            `Objeto inserido. Total: ${customObjects.length}/20.`;
    };

    $("clear-objects").onclick = () => {
        customObjects.forEach(item => {
            const colliderIndex = colliders.indexOf(item.collision);
            const targetIndex = rayTargets.indexOf(item.mesh);

            if (colliderIndex !== -1) {
                colliders.splice(colliderIndex, 1);
            }

            if (targetIndex !== -1) {
                rayTargets.splice(targetIndex, 1);
            }

            disposeObject(item.mesh);
        });

        customObjects.length = 0;

        $("editor-status").textContent = "Objetos criados removidos.";
    };

    $("editor-back").onclick = () => showScreen("menu");

    window.addEventListener("resize", () => {
        if (renderer && camera) {
            camera.aspect = innerWidth / innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(innerWidth, innerHeight);
        }

        resizeEditor();
    });

    let lastFrame = null;
    let renderFailed = false;

    function animate(timestamp) {
        requestAnimationFrame(animate);

        const delta = lastFrame === null
            ? 0
            : Math.min((timestamp - lastFrame) / 1000, .05);

        lastFrame = timestamp;

        if (renderFailed) return;

        try {
            if (state.mode === "playing") {
                updateGame(delta);
            }

            if (worldReady) {
                renderer.render(scene, camera);
            }

            if (
                currentScreen === "editor" &&
                editorRenderer &&
                editorMesh
            ) {
                editorMesh.rotation.y += delta * .5;
                editorRenderer.render(editorScene, editorCamera);
            }
        } catch (error) {
            renderFailed = true;
            pauseGame();

            if (document.pointerLockElement) {
                document.exitPointerLock();
            }

            console.error(error);

            showError(
                "O jogo encontrou um erro: " + error.message +
                ". Atualize a página depois de conferir o Console."
            );
        }
    }

    $("nickname").value = state.nickname || "Agente_01";

    syncSettings();
    applySettings();

    if (bootstrapError) {
        showError(bootstrapError);
        showScreen("profile");
    } else if (state.nickname) {
        openMenu();
    } else {
        showScreen("profile");
    }

    window.deadzoneScriptLoaded = true;
    requestAnimationFrame(animate);
})();