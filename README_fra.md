<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-GATEWAY-INDUSTRIAL banner" width="100%">
</p>

# 🌐 HYDRA-UMC-GATEWAY-INDUSTRIAL

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | 🇫🇷 <b>Français</b> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | <a href="README_jpn.md">🇯🇵 日本語</a></p>

### 🏭 Pont d'interopérabilité Industrie 4.0 pour les standards d'usine

<p align="left">
  <img src="https://img.shields.io/badge/Licence-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Standard-Industry%204.0-blue.svg" alt="Industry 4.0">
  <img src="https://img.shields.io/badge/Sécurité-mTLS%20%2F%20TLS%201.3-green.svg" alt="Security">
  <img src="https://img.shields.io/badge/Protocoles-OPC--UA%20%2F%20MQTT%20%2F%20MTConnect-orange.svg" alt="Protocols">
</p>

---

## 1. 🛠️ APERÇU TECHNIQUE

**HYDRA-UMC-GATEWAY-INDUSTRIAL** est le pont de communication sécurisé entre l'écosystème HYDRA-UMC et les normes industrielles externes. Il permet à la micro-usine d'interagir avec des automates tiers (PLC), des systèmes SCADA et des plateformes IIoT basées sur le cloud.

Il agit comme un traducteur multiprotocole, exposant les états robotiques internes et les télémétries d'outils sous forme de nœuds standardisés dans OPC-UA, de sujets MQTT ou de flux XML MTConnect, garantissant que l'essaim Hydra n'est jamais une île isolée dans l'usine de production.

### Caractéristiques principales :
* 🌐 **Prise en charge multi-standard :** Interfaces OPC-UA, MQTT et MTConnect intégrées.
* 🛡️ **Sécurité industrielle :** Mutual TLS (mTLS) et authentification par certificat pour toutes les connexions d'usine.
* 🔄 **Mappage d'état :** Traduction en temps réel de l'état JSON interne de Hydra en espaces d'adressage industriels standardisés.
* ⚡ **Haute fiabilité :** Pont léger dédié optimisé pour une disponibilité industrielle 24h/24 et 7j/7.
* 🚦 **Réel v0 - Liste d'autorisation de commandes + Backpressure :** `POST /command` est protégé par une liste d'autorisation par défaut-refus par protocole, une limite de concurrence bornée et un vrai timeout - voir « Vérification d'honnêteté » ci-dessous pour ce qui est appliqué exactement aujourd'hui.

**Vérification d'honnêteté - ce qui fonctionne réellement aujourd'hui :** `POST /command { protocol, operation, target }` est réel : l'opération doit être explicitement listée pour son protocole (`403` sinon - v0 n'autorise que les opérations de type lecture/publication, rien qui écrive sur un PLC en direct), pas plus qu'un nombre borné de commandes ne s'exécutent à la fois (`429` au-delà), et une commande qui ne se résout pas à temps est signalée comme expirée (`504`) plutôt que laissée en attente indéfiniment. Le chemin d'exécution par défaut réutilise les propres sondes d'accessibilité réelles de ce projet - honnête sur le fait qu'il n'effectue pas encore une vraie écriture au niveau protocole OPC-UA/MQTT/MTConnect, puisqu'aucun des trois enfants n'expose encore de vraie API de commande non plus. Voir `CHANGELOG.md` pour ce qui a été livré exactement.

---

## 2. 🔄 ARCHITECTURE DE LA PASSERELLE

```mermaid
flowchart LR
    INTERNAL["Écosystème HYDRA-UMC (API interne)"] --> GATEWAY["HYDRA-GATEWAY-INDUSTRIAL"]
    GATEWAY --> OPC["Serveur OPC-UA (PLC)"]
    GATEWAY --> MQTT["Broker MQTT (IIoT / Cloud)"]
    GATEWAY --> MT["Adaptateur MTConnect (SCADA)"]
    OPC --> EXT["Réseau d'usine"]
    MQTT --> EXT
    MT --> EXT
```

---

## 3. 🧱 ARCHITECTURE & DÉCISIONS DE CONCEPTION

* **Pourquoi c'est le parent d'intégration, pas un pair, de ses 3 enfants.** HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER et HYDRA-UMC-MTCONNECT-ADAPTER traduisent tous le MÊME état sous-jacent de HYDRA-UMC-SERVER vers 3 protocoles industriels différents - posséder le routage/l'authentification partagés à un seul endroit évite 3 traductions indépendantes et potentiellement incohérentes du même état.
* **Pourquoi 3 adaptateurs de protocole séparés, pas une passerelle qui fait tout.** OPC-UA, MQTT et MTConnect sont structurellement différents (espace d'adressage contre sujets pub/sub contre flux XML device/agent) - un processus par protocole signifie qu'un client MQTT lent ou cassé n'affecte jamais celui d'OPC-UA, et chacun peut être activé/désactivé indépendamment selon le déploiement.
* **Pourquoi le point d'entrée n'imprime qu'identité/version, et se termine après la mise en place d'un listener de health-check.** Étape d'andamiaje : prouver que le processus démarre et reste actif (pas seulement s'exécute et se termine, contrairement à la plupart des autres squelettes Node de cet écosystème) précède la vraie logique de traduction de protocole, une vraie passerelle étant par nature un service de longue durée.
* **Comment cela s'intègre dans le reste de l'écosystème.** Le parent d'intégration de la famille Passerelle Industrielle - expose le propre état de HYDRA-UMC-SERVER aux systèmes d'atelier (MES/SCADA/historiens) qui parlent OPC-UA, MQTT ou MTConnect plutôt que la propre API REST/WebSocket de cet écosystème.
* **`GET /status` effectue une vérification réelle et en direct à chaque requête.** `src/probes.ts` réalise une vraie connexion TCP pour OPC-UA/MQTT et une vraie requête HTTP `GET` pour MTConnect vers chaque enfant - `reachable`/`latencyMs`/`error` par enfant et un `allReachable` agrégé sont calculés au moment de la requête, et non renvoyés depuis une liste statique ou en cache. Vérifié de bout en bout : les 3 enfants réels ont été démarrés, `/status` les a tous signalés comme accessibles, l'un d'eux a ensuite été réellement arrêté, et l'appel suivant à `/status` a correctement basculé uniquement cet enfant en inaccessible avec un vrai `ECONNREFUSED`. L'hôte/port/URL de chaque enfant est configurable via des variables d'environnement, avec pour valeur par défaut le nom de service que `docker-compose.yml` utilise déjà.
* **Pourquoi la liste d'autorisation de `POST /command` est par défaut-refus, pas par défaut-autorisation.** Une passerelle industrielle qui relaie n'importe quelle chaîne d'opération qu'on lui donne est un risque dès l'instant où un enfant expose un vrai chemin d'écriture - partir de « rien n'est autorisé sauf mention explicite » signifie qu'ajouter une opération dangereuse (une écriture de nœud OPC-UA, une publication de config retenue MQTT) est toujours une décision délibérée et révisable plus tard, jamais un défaut accidentel aujourd'hui.
* **Pourquoi l'autorisation est vérifiée avant le backpressure dans `CommandDispatcher.dispatch()`.** Une commande non autorisée doit être rejetée de la même façon quelle que soit l'occupation actuelle de la passerelle - si la capacité était vérifiée en premier, une opération interdite pourrait parfois se faufiler comme « acceptée » (un créneau était libre) ou parfois se lire comme « juste occupée » (il ne l'était pas), fuitant des informations de timing sur la charge de la passerelle à travers ce qui devrait être une décision purement d'autorisation.
* **Pourquoi l'exécuteur de commande par défaut réutilise les sondes d'accessibilité plutôt qu'un bouchon qui réussit toujours.** `src/probes.ts` répond déjà réellement à « cet enfant est-il vraiment là » - le réutiliser signifie que `POST /command` échoue honnêtement (`502 downstream_unreachable`) contre un enfant à l'arrêt, plutôt que de rapporter `accepted` pour une commande qui n'aurait jamais pu aller nulle part.

---

## 📂 STRUCTURE DES RÉPERTOIRES

```text
HYDRA-UMC-GATEWAY-INDUSTRIAL/
├── src/
│   ├── probes.ts        # Vraies vérifications d'accessibilité TCP/HTTP par enfant
│   ├── command.ts        # Vrai CommandDispatcher : liste d'autorisation + backpressure + timeout
│   ├── version.ts        # Vraie version du paquet à l'exécution, lue depuis package.json
│   └── server.ts         # App Express : GET /status, POST /command
├── tests/               # Vraie suite vitest (probes, server, command)
├── docs/               # Documentation et référence de mappage
├── build/               # Sortie compilée (npm run build)
├── images/             # Médias et diagrammes
├── scripts/            # Scripts utilitaires (bump-version.mjs)
├── tools/
│   ├── build_test.py    # Vérification de build sans versionnage
│   └── ci_validate.py   # Validation manifeste/CHANGELOG/docs utilisée par CI
├── bump_manifest_version.py # Synchronise la version de hydra-umc.project.json avec celle de package.json (--sync)
├── .env.example         # Modèle de variables d'environnement
├── build.sh/.bat        # Incrémente la version puis npm run build
├── build-test.sh/.bat   # Vérification de build sans versionnage
├── dev.sh/.bat           # Exécute le serveur directement depuis les sources, sans étape de build
├── Dockerfile           # Image de conteneur propre à ce service
├── docker-compose.yml   # Démarre ce Gateway + ses 3 enfants ensemble
└── README.md
```

Service réseau pur, sans matériel propre - `hardware/`, `firmware/` et
`os/` sont omis conformément à la politique de structure du dépôt.

---

## 🐳 INTÉGRATION DES 3 PASSERELLES ENFANTS

C'est un vrai dépôt d'intégration, pas seulement de la documentation -
`docker-compose.yml` démarre ce Gateway avec ses trois enfants
(**HYDRA-UMC-OPCUA-SERVER**, **HYDRA-UMC-MQTT-BROKER**,
**HYDRA-UMC-MTCONNECT-ADAPTER**) en un seul réseau Docker, en supposant
que les quatre dépôts sont clonés en tant que dossiers frères (la
disposition déjà utilisée par l'org GitHub de cet écosystème) :

```bash
docker compose up --build
```

Cela démarre les 4 services sur les mêmes ports que chacun utilise déjà
seul : ce Gateway sur `8000`, OPC-UA sur `4840`, MQTT sur `1883`,
MTConnect sur `5000`. `GET http://localhost:8000/status` rapporte la
version propre du Gateway et les enfants qu'il s'attend à pouvoir
joindre.

---

## 🛠️ ENVIRONNEMENT DE DÉVELOPPEMENT

### Prérequis
- [Node.js](https://nodejs.org/) (v18 ou supérieur recommandé)
- npm

### Installation
```bash
npm install
```

### Mode Développement
Exécute le serveur d'agrégation directement avec `tsx` (sans bundler) :
- **Windows :** double-cliquer sur `dev.bat` ou exécuter `npm run dev`
- **Linux/Mac :** exécuter `./dev.sh` ou `npm run dev`

### Build de Production
Regroupe le serveur en un seul fichier déployable avec esbuild :
- **Windows :** double-cliquer sur `build.bat` ou exécuter `npm run build`
- **Linux/Mac :** exécuter `./build.sh` ou `npm run build`

Puis démarrez-le avec :
```bash
npm start
```

Le serveur écoute sur `0.0.0.0:8000` - `GET /status` rapporte la version
propre du Gateway ainsi que le nom/protocole/endpoint de chaque passerelle
enfant qu'il représente.

Exemple réel - une commande autorisée contre un enfant qui ne tourne pas,
une opération non autorisée, et une requête malformée :

```bash
curl -X POST http://localhost:8000/command -H "Content-Type: application/json" \
  -d '{"protocol":"OPC-UA","operation":"read","target":"ns=2;s=Line1.Status"}'
# 502 {"status":"downstream_unreachable","reason":"TCP connect to opcua-server:4840 timed out after 2000ms"}

curl -X POST http://localhost:8000/command -H "Content-Type: application/json" \
  -d '{"protocol":"OPC-UA","operation":"write","target":"ns=2;s=Line1.SetPoint"}'
# 403 {"status":"rejected_unauthorized","reason":"operation \"write\" is not allowlisted for OPC-UA"}

curl -X POST http://localhost:8000/command -H "Content-Type: application/json" -d '{"protocol":"OPC-UA"}'
# 400 {"error":"protocol, operation and target are required strings"}
```

### Gestion des versions
Chaque `npm run build` réel incrémente automatiquement le `version` de
`package.json` (`scripts/bump-version.mjs`, première étape du script
`build`) - un « compteur kilométrique » en base 10 : patch +1 par build,
avec report vers minor (et de minor vers major) au-delà de 9 plutôt que
d'atteindre un segment à deux chiffres (`0.0.9` -> `0.1.0`, pas `0.0.10`).

---

## 🚀 FEUILLE DE ROUTE
* **Phase 1 :** Implémentation d'OPC-UA Pub/Sub pour l'échange de données à haute vitesse et le pontage des protocoles hérités.
* **Phase 2 :** Cluster de brokers MQTT pour la gestion massive des appareils IoT et une haute simultanéité.
* **Phase 3 :** Prise en charge de l'adaptateur MTConnect pour l'intégration de machines CNC et d'automates multi-fournisseurs.
* **Phase 4 :** Conformité totale à la cybersécurité ISO-27001 pour l'Passerelle Industrielle et prise en charge de l'adaptateur logiciel Profinet.

---

## 🔗 Projets Liés

Ce projet fait partie de l'écosystème robotique HYDRA-UMC du même auteur (JuanenRac / Electro Hobby 3D). Bon à savoir, car une demande pourrait en réalité concerner l'un de ceux-ci plutôt que ce dépôt.

**Projets Enfants** — chacun est un adaptateur de protocole via lequel cette passerelle achemine
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — vrai espace d'adressage OPC-UA, vérifié avec une vraie session client du protocole binaire.
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — vrai broker MQTT avec authentification par client optionnelle et ACL de sujets.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — vrais points de terminaison XML MTConnect `/probe` et `/current`, avec sortie en mode dégradé.

**Directement Liés**
- **[HYDRA-UMC-SERVER](https://github.com/JuanenRac/HYDRA-UMC-SERVER)** — le vrai backend headless (REST/WebSocket) auquel parle réellement chaque client de contrôle ; la source de l'état que cette passerelle expose.

**Fait Également Partie de l'Écosystème**

*Matériel & Plateforme de Base*
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — la carte mère physique du bras robotique : hôte CM5 + coprocesseur STM32H745 double cœur, coordonnant jusqu'à 8 bras-outils via CAN-OTA/SPI-OTA.
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — couche produit reproductible sur Raspberry Pi OS pour le CM5 : agent en lecture seule, config/profils validés, provisionnement WiFi de premier contact.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — le contrat JSON-Schema partagé et la barrière de sécurité contre laquelle chaque bridge valide ses commandes.

*Backend Central & Clients*
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — tableau de bord de contrôle web avec visualisation 3D multi-robot en temps réel.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — application de contrôle Android native avec connexion biométrique et un compagnon Wear OS jumelé.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — application de contrôle iOS/iPadOS (Flutter) avec synchronisation WebSocket en temps réel.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interface tactile native pour l'écran tactile DSI 7" embarqué, intégrée directement sur le CM5.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — créateur/éditeur graphique de bureau pour URDF qui envoie les modèles terminés vers le propre catalogue de STUDIO.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — frontière de coordination pour les flottes AGV/AMR via un éditeur MQTT VDA 5050 réel.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordinateur haut niveau pour cellules CNC avec accès réel au statut/octets de contrôle GRBL.
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — frontière de coordination pour droïdes à pattes/humanoïdes, avec un véritable émetteur de commandes Boston Dynamics Spot.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordinateur de sécurité pour cellules laser lisant 3 vraies sécurités GPIO de clé/enceinte/verrouillage.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinateur haut niveau sûr pour le flux de cartes du pick-and-place OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — frontière de coordination sûre pour imprimantes 3D Moonraker/Klipper, avec de vraies commandes de tâche contrôlées.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinateur de sécurité avec un vrai transport ROS 2 rclpy à importation paresseuse.
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — frontière de coordination pour UAV équipés de caméra, avec un véritable émetteur de commandes MAVLink.

*Plateforme d'Outils URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware pour la carte physique Universal Robot Tool Controller, plus de 25 profils d'outil sur bus CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — outil de bureau à interface graphique pour flasher les cartes URTC, CAN-OTA plus SWD/JTAG puce complète.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — outil de bureau de diagnostic CAN-bus en direct pour cartes URTC, un panneau par profil d'outil.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternative basée navigateur à URTC-TESTER via la Web Serial API, sans installation locale.

*Nœud IA de Vision (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — hub d'intégration pour le pipeline de vision Hailo-8, avec une vraie vérification de disponibilité matérielle par étape.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registre réel de modèles compilés avec vérification de chargement sécurisé par architecture Hailo/checksum.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — générateur réel de pipeline GStreamer + config MediaMTX, avec une vraie frontière d'intégration HailoRT.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — vraie loi de correction Position-Based Visual Servoing, verrouillée sur l'état de zone en amont.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — vraie vérification de violation de zone et demande d'E-STOP, avec application de la fraîcheur de calibration.

*Nœud IA Cognitif (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — hub d'intégration pour le pipeline cognitif Hailo-10 (orchestration LLM/VLA/voix).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — vrai encodage/décodage de jetons d'action et génération de trajectoire pour un modèle Vision-Language-Action.
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — vrai front-end vocal (VAD + analyseur d'intention) avec un relais Watch borné et soumis à confirmation.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — vraie décomposition de tâches basée sur des règles et récupération sémantique d'erreurs sur les codes d'erreur MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — vraie recherche documentaire TF-IDF (bibliothèque standard uniquement) sur les propres documents Markdown de cet écosystème.

*Orchestration & Essaim*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — hub d'intégration avec un vrai contrat de rapport de santé gRPC/Protobuf et une machine à états de mission.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — vraie file de tâches basée sur la priorité avec déduplication, via une vraie API HTTP.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — vrai chien de garde de santé de flotte basé sur gRPC, avec retry/backoff et détection d'incohérence d'identité.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — vrai planificateur de trajectoire 3D basé sur RRT, avec vraie validation des collisions obstacle/espace de travail.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — vraie synchronisation d'état CRDT LWW-Element-Map, testée par propriétés pour la convergence multi-cellule.

*Jumeau Numérique & Simulation*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — hub d'intégration pour le moteur de jumeau numérique, avec un vrai contrat de synchronisation par compatibilité de version.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — vrai verrouillage de sécurité hardware-in-the-loop routant les commandes entre simulation et matériel réel.
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — vraie cinématique directe et validation des limites articulaires sur un vrai sous-ensemble URDF.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — vrai générateur procédural de scènes 2D avec export d'annotations YOLO/COCO.

*Données & Analytique*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — vrai magasin de séries temporelles basé sur sqlite3, avec une vraie API HTTP d'ingestion/requête.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — vrai détecteur d'anomalies FFT + ligne de base statistique, avec surveillance de dérive.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — vrai calcul OEE/disponibilité sur l'historique de DATALAKE, avec export CSV reproductible.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — vrai pipeline d'ingestion CAN/WebSocket vers DATALAKE, avec déduplication par séquence.

*Outils Complémentaires & Opérations de l'Écosystème*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — panneaux Smart Summaries et Anomaly Highlighting sur DATALAKE/ANOMALY-DETECTOR, avec un repli statistique honnête.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — CLI de flotte avec un vrai contrat de codes de sortie stable, un vrai client en direct de la propre API de HYDRA-UMC-SERVER.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — application compagnon WearOS avec de vraies alertes haptiques et un relais vocal vers le téléphone jumelé.
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware pour un rack de montage de cartes avec décodage réel d'ID d'outil et logique de préchauffage Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware plus un vrai compagnon de vision Python pour une tête d'outil d'inspection thermique/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — outil administratif de bureau qui découvre, clone et met à jour chaque dépôt de cet écosystème.


---

## 📚 Documentation & Communauté

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — pile technologique et lignes directrices de codage pour une pull request.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — les normes de comportement attendues dans cette communauté.
- **[SECURITY.md](SECURITY.md)** — comment signaler une vulnérabilité, et les véritables axes de sécurité de ce projet.
- **[SUPPORT.md](SUPPORT.md)** — où poser des questions et signaler des bugs.
- **[LICENSE.md](LICENSE.md)** — la licence propre de ce projet.

## 👤 AUTEUR
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 LICENCE
GPL-3.0 - Voir le fichier LICENSE pour plus de détails.
