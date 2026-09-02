<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-GATEWAY-INDUSTRIAL banner" width="100%">
</p>

# 🌐 HYDRA-UMC-GATEWAY-INDUSTRIAL

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | 🇮🇹 <b>Italiano</b> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | <a href="README_jpn.md">🇯🇵 日本語</a></p>

### 🏭 Bridge di interoperabilità Industry 4.0 per standard di fabbrica

<p align="left">
  <img src="https://img.shields.io/badge/Licenza-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Standard-Industry%204.0-blue.svg" alt="Industry 4.0">
  <img src="https://img.shields.io/badge/Sicurezza-mTLS%20%2F%20TLS%201.3-green.svg" alt="Security">
  <img src="https://img.shields.io/badge/Protocolli-OPC--UA%20%2F%20MQTT%20%2F%20MTConnect-orange.svg" alt="Protocols">
</p>

---

## 1. 🛠️ PANORAMICA TECNICA

**HYDRA-UMC-GATEWAY-INDUSTRIAL** è il ponte di comunicazione sicuro tra l'ecosistema HYDRA-UMC e gli standard industriali esterni. Consente alla micro-fabbrica di interagire con PLC di terze parti, sistemi SCADA e piattaforme IIoT basate su cloud.

Funge da traduttore multi-protocollo, esponendo gli stati robotici interni e le telemetrie degli strumenti come nodi standardizzati in OPC-UA, topic MQTT o stream XML MTConnect, assicurando che lo sciame Hydra non sia mai un'isola isolata nell'impianto di produzione.

### Caratteristiche principali:
* 🌐 **Supporto multi-standard:** Interfacce OPC-UA, MQTT e MTConnect integrate.
* 🛡️ **Sicurezza industriale:** Mutual TLS (mTLS) e autenticazione basata su certificati per tutte le connessioni di fabbrica.
* 🔄 **Mappatura dello stato:** Traduzione in tempo reale dello stato JSON interno di Hydra in spazi di indirizzamento industriali standardizzati.
* ⚡ **Alta affidabilità:** Bridge leggero dedicato ottimizzato per un tempo di attività industriale 24/7.
* 🚦 **Reale v0 - Allowlist dei comandi + Backpressure:** `POST /command` è protetto da una allowlist per-protocollo a rifiuto predefinito, un limite di concorrenza limitato e un vero timeout - vedi "Verifica di onestà" sotto per cosa viene applicato esattamente oggi.

**Verifica di onestà - cosa funziona davvero oggi:** `POST /command { protocol, operation, target }` è reale: l'operazione deve essere esplicitamente in allowlist per il suo protocollo (`403` altrimenti - v0 permette solo operazioni di tipo lettura/pubblicazione, nulla che scriva su un PLC in funzione), non vengono eseguiti più di un numero limitato di comandi alla volta (`429` oltre quel limite), e un comando che non si risolve in tempo viene segnalato come scaduto (`504`) invece di restare in sospeso. Il percorso di esecuzione predefinito riutilizza le sonde di raggiungibilità reali di questo progetto - onesto sul fatto che non esegue ancora una vera scrittura a livello di protocollo OPC-UA/MQTT/MTConnect, dato che nessuno dei tre figli espone ancora una vera API di comando. Vedi `CHANGELOG.md` per ciò che è stato consegnato esattamente.

---

## 2. 🔄 ARCHITETTURA DEL GATEWAY

```mermaid
flowchart LR
    INTERNAL["HYDRA-UMC Ecosystem (Internal API)"] --> GATEWAY["HYDRA-GATEWAY-INDUSTRIAL"]
    GATEWAY --> OPC["OPC-UA Server (PLC)"]
    GATEWAY --> MQTT["MQTT Broker (IIoT / Cloud)"]
    GATEWAY --> MT["MTConnect Adapter (SCADA)"]
    OPC --> EXT["Rete di fabbrica"]
    MQTT --> EXT
    MT --> EXT
```

---

## 3. 🧱 ARCHITETTURA E DECISIONI DI PROGETTAZIONE

* **Perché è il genitore di integrazione, non un pari, dei suoi 3 figli.** HYDRA-UMC-OPCUA-SERVER, HYDRA-UMC-MQTT-BROKER e HYDRA-UMC-MTCONNECT-ADAPTER traducono tutti lo STESSO stato sottostante di HYDRA-UMC-SERVER in 3 protocolli industriali diversi - possedere il routing/l'autenticazione condivisi in un unico posto evita 3 traduzioni indipendenti e potenzialmente incoerenti dello stesso stato.
* **Perché 3 adattatori di protocollo separati, non un gateway che fa tutto.** OPC-UA, MQTT e MTConnect sono strutturalmente diversi (address space contro topic pub/sub contro flussi XML device/agent) - un processo per protocollo significa che un client MQTT lento o rotto non influenza mai quello OPC-UA, e ciascuno può essere abilitato/disabilitato indipendentemente per deployment.
* **Perché il punto di ingresso stampa solo identità/versione, e termina dopo che un listener di health-check si avvia.** Fase di andamiaje: dimostrare che il processo si avvia e resta attivo (non solo gira ed esce, a differenza della maggior parte degli altri scheletri Node di questo ecosistema) precede la vera logica di traduzione di protocollo, dato che un vero gateway è per natura un servizio di lunga durata.
* **Come si inserisce nel resto dell'ecosistema.** Il genitore di integrazione della famiglia Gateway Industriale - espone lo stato proprio di HYDRA-UMC-SERVER a sistemi di stabilimento (MES/SCADA/storici) che parlano OPC-UA, MQTT o MTConnect invece dell'API REST/WebSocket propria di questo ecosistema.
* **`GET /status` esegue un controllo reale e in tempo reale ad ogni richiesta.** `src/probes.ts` effettua una connessione TCP reale per OPC-UA/MQTT e una richiesta HTTP `GET` reale per MTConnect verso ciascun figlio - `reachable`/`latencyMs`/`error` per figlio e un `allReachable` aggregato vengono calcolati al momento della richiesta, non restituiti da un elenco statico o in cache. Verificato end-to-end: i 3 figli reali sono stati avviati, `/status` li ha segnalati tutti raggiungibili, uno di essi è stato poi realmente terminato, e la chiamata successiva a `/status` ha correttamente contrassegnato solo quel figlio come non raggiungibile con un vero `ECONNREFUSED`. Host/porta/URL di ciascun figlio sono configurabili tramite variabili d'ambiente, con lo stesso nome di servizio già usato da `docker-compose.yml` come predefinito.
* **Perché la allowlist di `POST /command` è a rifiuto predefinito, non a permesso predefinito.** Un gateway industriale che inoltra qualsiasi stringa di operazione ricevuta è un rischio nel momento in cui un figlio espone un vero percorso di scrittura - partire da "niente è permesso a meno che non sia esplicitamente elencato" significa che aggiungere un'operazione pericolosa (una scrittura di nodo OPC-UA, una pubblicazione di configurazione retained MQTT) è sempre una decisione deliberata e rivedibile in futuro, mai un predefinito accidentale oggi.
* **Perché l'autorizzazione viene controllata prima del backpressure in `CommandDispatcher.dispatch()`.** Un comando non autorizzato deve essere rifiutato sempre allo stesso modo indipendentemente da quanto sia occupato il gateway in quel momento - se la capacità fosse controllata per prima, un'operazione non permessa potrebbe a volte passare come "accepted" (uno slot era libero) o a volte apparire come "solo occupato" (non lo era), facendo trapelare informazioni sul carico del gateway attraverso quella che dovrebbe essere una decisione puramente di autorizzazione.
* **Perché l'esecutore di comandi predefinito riutilizza le sonde di raggiungibilità invece di uno stub che ha sempre successo.** `src/probes.ts` risponde già davvero a "questo figlio è davvero lì" - riutilizzarlo significa che `POST /command` fallisce onestamente (`502 downstream_unreachable`) contro un figlio spento, invece di riportare `accepted` per un comando che non sarebbe mai potuto arrivare da nessuna parte.

---

## 📂 STRUTTURA DELLE CARTELLE

```text
HYDRA-UMC-GATEWAY-INDUSTRIAL/
├── src/
│   ├── probes.ts        # Vere verifiche di raggiungibilità TCP/HTTP per figlio
│   ├── command.ts        # Vero CommandDispatcher: allowlist + backpressure + timeout
│   ├── version.ts        # Vera versione del pacchetto a runtime, letta da package.json
│   └── server.ts         # App Express: GET /status, POST /command
├── tests/               # Vera suite vitest (probes, server, command)
├── docs/               # Documentazione e riferimento mappatura
├── build/               # Output compilato (npm run build)
├── images/             # Media e diagrammi
├── scripts/            # Script di utilità (bump-version.mjs)
├── tools/
│   ├── build_test.py    # Controllo build senza versionamento
│   └── ci_validate.py   # Validazione manifest/CHANGELOG/docs usata dalla CI
├── bump_manifest_version.py # Sincronizza la versione di hydra-umc.project.json con quella di package.json (--sync)
├── .env.example         # Modello delle variabili d'ambiente
├── build.sh/.bat        # Aggiorna la versione, poi npm run build
├── build-test.sh/.bat   # Controllo build senza versionamento
├── dev.sh/.bat           # Esegue il server direttamente dal codice sorgente, senza build
├── Dockerfile           # Immagine container propria di questo servizio
├── docker-compose.yml   # Avvia questo Gateway + i suoi 3 figli insieme
└── README.md
```

Servizio di rete puro, senza hardware proprio - `hardware/`, `firmware/`
e `os/` sono omesse secondo la politica della struttura del repository.

---

## 🐳 INTEGRAZIONE DEI 3 BRIDGE FIGLI

Questo è un vero repo di integrazione, non solo documentazione -
`docker-compose.yml` avvia questo Gateway insieme ai suoi tre figli
(**HYDRA-UMC-OPCUA-SERVER**, **HYDRA-UMC-MQTT-BROKER**,
**HYDRA-UMC-MTCONNECT-ADAPTER**) come un'unica rete Docker, assumendo che
i quattro repo siano clonati come cartelle sorelle (la disposizione già
usata dall'org GitHub di questo ecosistema):

```bash
docker compose up --build
```

Questo avvia i 4 servizi sulle stesse porte che ciascuno usa già in modo
indipendente: questo Gateway su `8000`, OPC-UA su `4840`, MQTT su `1883`,
MTConnect su `5000`. `GET http://localhost:8000/status` riporta la
versione propria del Gateway e quali figli si aspetta di poter
raggiungere.

---

## 🛠️ AMBIENTE DI SVILUPPO

### Requisiti
- [Node.js](https://nodejs.org/) (v18 o superiore consigliato)
- npm

### Installazione
```bash
npm install
```

### Modalità Sviluppo
Esegue il server di aggregazione direttamente con `tsx` (senza bundler):
- **Windows:** doppio clic su `dev.bat` oppure eseguire `npm run dev`
- **Linux/Mac:** eseguire `./dev.sh` oppure `npm run dev`

### Build di Produzione
Impacchetta il server in un unico file distribuibile con esbuild:
- **Windows:** doppio clic su `build.bat` oppure eseguire `npm run build`
- **Linux/Mac:** eseguire `./build.sh` oppure `npm run build`

Poi avvialo con:
```bash
npm start
```

Il server resta in ascolto su `0.0.0.0:8000` - `GET /status` riporta la
versione propria del Gateway più nome/protocollo/endpoint di ciascun
bridge figlio a cui fa da facciata.

Esempio reale - un comando in allowlist contro un figlio che non è in
esecuzione, un'operazione non autorizzata e una richiesta malformata:

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

### Versionamento
Ogni `npm run build` reale incrementa automaticamente il `version` di
`package.json` (`scripts/bump-version.mjs`, primo passo dello script
`build`) - un "contachilometri" in base 10: patch +1 per build, con
riporto a minor (e da minor a major) oltre il 9 invece di raggiungere mai
un segmento a due cifre (`0.0.9` -> `0.1.0`, non `0.0.10`).

---

## 🚀 TABELLA DI MARCIA
* **Fase 1:** Implementazione di OPC-UA Pub/Sub per lo scambio di dati ad alta velocità e bridging di protocolli legacy.
* **Fase 2:** Cluster MQTT Broker per la gestione massiva di dispositivi IoT e alta concorrenza.
* **Fase 3:** Supporto per l'adattatore MTConnect per l'integrazione di macchinari CNC e PLC multi-vendor.
* **Fase 4:** Conformità completa alla cybersicurezza ISO-27001 per Gateway Industriale e supporto per l'adattatore software Profinet.

---

## 🔗 Progetti Correlati

Questo progetto fa parte dell'ecosistema robotico HYDRA-UMC dello stesso autore (JuanenRac / Electro Hobby 3D). Vale la pena conoscerlo, poiché una richiesta potrebbe in realtà riguardare uno di questi invece di questo repository.

**Progetti Figli** — ciascuno è un adattatore di protocollo attraverso cui questo gateway instrada
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — vero spazio di indirizzi OPC-UA, verificato con una vera sessione client del protocollo binario.
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — vero broker MQTT con autenticazione opzionale per client e ACL sui topic.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — veri endpoint XML `/probe` e `/current` di MTConnect, con output in modalità degradata.

**Direttamente Correlati**
- **[HYDRA-UMC-SERVER](https://github.com/JuanenRac/HYDRA-UMC-SERVER)** — il vero backend headless (REST/WebSocket) con cui parla davvero ogni client di controllo; la fonte dello stato che questo gateway espone.

**Fa Anche Parte dell'Ecosistema**

*Hardware e Piattaforma di Base*
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — la scheda madre fisica del braccio robotico: host CM5 + coprocessore STM32H745 dual-core, che coordina fino a 8 bracci utensile via CAN-OTA/SPI-OTA.
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — livello prodotto riproducibile su Raspberry Pi OS per il CM5: agente in sola lettura, config/profili validati, provisioning WiFi al primo contatto.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — il contratto JSON-Schema condiviso e la barriera di sicurezza contro cui ogni bridge valida i propri comandi.

*Backend Centrale e Client*
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — dashboard di controllo web con visualizzazione 3D multi-robot in tempo reale.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — app di controllo nativa per Android con login biometrico e un companion Wear OS abbinato.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — app di controllo per iOS/iPadOS (Flutter) con sincronizzazione WebSocket in tempo reale.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interfaccia touch nativa per il touchscreen DSI da 7" a bordo, incorporata direttamente nel CM5.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — creatore/editor grafico desktop di URDF che invia i modelli finiti al catalogo di STUDIO.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — barriera di coordinamento per flotte AGV/AMR tramite un publisher MQTT VDA 5050 reale.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordinatore ad alto livello per celle CNC con accesso reale a stato/byte di controllo GRBL.
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — barriera di coordinamento per droidi con zampe/umanoidi, con un vero mittente di comandi per Boston Dynamics Spot.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordinatore di sicurezza per celle laser che legge 3 salvaguardie GPIO reali di chiave/involucro/interblocco.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinatore ad alto livello sicuro per il flusso schede del pick-and-place OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — barriera di coordinamento sicura per stampanti 3D Moonraker/Klipper, con comandi di lavoro reali e controllati.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinatore di sicurezza con un vero trasporto ROS 2 rclpy, importato in modo lazy.
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — barriera di coordinamento per UAV dotati di fotocamera, con un vero mittente di comandi MAVLink.

*Piattaforma Strumenti URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware per la scheda fisica dell'Universal Robot Tool Controller, oltre 25 profili utensile su bus CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — strumento desktop con GUI per il flashing delle schede URTC, CAN-OTA più SWD/JTAG a chip intero.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — strumento desktop di diagnostica CAN-bus dal vivo per schede URTC, un pannello per profilo utensile.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternativa basata su browser a URTC-TESTER tramite la Web Serial API, senza installazione locale.

*Nodo IA Visione (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — hub di integrazione per la pipeline di visione Hailo-8, con un vero controllo di prontezza hardware per fase.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registro reale di modelli compilati con verifica di caricamento sicuro per architettura Hailo/checksum.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — generatore reale di pipeline GStreamer + config MediaMTX, con una vera barriera di integrazione HailoRT.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — vera legge di correzione Position-Based Visual Servoing, con cancello di sicurezza sullo stato di zona a monte.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — vero controllo di violazione zona e richiesta E-STOP, con imposizione della freschezza di calibrazione.

*Nodo IA Cognitivo (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — hub di integrazione per la pipeline cognitiva Hailo-10 (orchestrazione LLM/VLA/voce).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — vera codifica/decodifica di token d'azione e generazione di traiettoria per un modello Vision-Language-Action.
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — vero front-end vocale (VAD + parser di intenti) con un relay verso Watch limitato e soggetto a conferma.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — vera scomposizione dei task basata su regole e recupero semantico degli errori sui codici errore MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — vera ricerca documentale TF-IDF (solo libreria standard) sui documenti Markdown di questo ecosistema.

*Orchestrazione e Sciame*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — hub di integrazione con un vero contratto di health-report gRPC/Protobuf e una macchina a stati di missione.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — vera coda di lavori basata su priorità con deduplicazione, su una vera API HTTP.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — vero watchdog di salute della flotta basato su gRPC, con retry/backoff e rilevamento di discrepanza d'identità.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — vero pianificatore di percorsi 3D basato su RRT, con vera validazione delle collisioni ostacolo/spazio di lavoro.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — vera sincronizzazione di stato CRDT LWW-Element-Map, con property test per la convergenza multi-cella.

*Gemello Digitale e Simulazione*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — hub di integrazione per il motore di gemello digitale, con un vero contratto di sincronizzazione per compatibilità di versione.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — vero interblocco di sicurezza hardware-in-the-loop che instrada i comandi tra simulazione e hardware reale.
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — vera cinematica diretta e validazione dei limiti articolari su un vero sottoinsieme URDF.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — vero generatore procedurale di scene 2D con esportazione di annotazioni YOLO/COCO.

*Dati e Analisi*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — vero archivio di serie temporali basato su sqlite3, con una vera API HTTP di ingestione/query.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — vero rilevatore di anomalie FFT + baseline statistica, con monitoraggio della deriva.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — vero calcolo OEE/disponibilità sullo storico di DATALAKE, con esportazione CSV riproducibile.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — vera pipeline di ingestione CAN/WebSocket verso DATALAKE, con deduplicazione per sequenza.

*Strumenti Complementari e Operazioni dell'Ecosistema*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — pannelli Smart Summaries e Anomaly Highlighting su DATALAKE/ANOMALY-DETECTOR, con un fallback statistico onesto.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — CLI di flotta con un vero e stabile contratto di exit-code, un client live reale della stessa API di HYDRA-UMC-SERVER.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — app companion WearOS con avvisi aptici reali e un relay vocale verso il telefono abbinato.
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware per un rack di montaggio schede con decodifica reale dell'ID utensile e logica di preriscaldamento Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware più un vero companion di visione Python per una testa utensile di ispezione termica/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — strumento amministrativo desktop che scopre, clona e aggiorna ogni repository di questo ecosistema.


## 👤 AUTORE
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 LICENZA
GPL-3.0 - Vedere LICENSE per i dettagli.
