(function () {
  "use strict";

  /* ================= Configuración ================= */

  var CFG = window.QUIZ_CONFIG || {};
  var params = new URLSearchParams(window.location.search);
  var API_URL = resolveApiUrl();
  var API_KEY = typeof CFG.API_KEY === "string" ? CFG.API_KEY : "";
  var REQUEST_TIMEOUT_MS = 15000;
  var LOW_TIME_S = 5;
  var ALIAS_KEY = "quiz.alias";
  var ALIAS_RE = /^[a-z]{3,12}-[a-z]{3,12}-\d{2}$/;

  var motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function reducedMotion() { return !!(motionQuery && motionQuery.matches); }

  function resolveApiUrl() {
    var override = params.get("api");
    if (override) {
      try {
        var u = new URL(override, window.location.href);
        if (u.protocol === "https:" || u.protocol === "http:") return u.href;
      } catch (e) { /* URL inválida: se ignora */ }
    }
    return typeof CFG.API_URL === "string" ? CFG.API_URL : "";
  }

  /* ================= DOM ================= */

  function $(id) { return document.getElementById(id); }

  var el = {
    aliasWrap: $("alias-wrap"),
    alias: $("alias"),
    screens: {
      loading: $("screen-loading"),
      start: $("screen-start"),
      quiz: $("screen-quiz"),
      final: $("screen-final"),
      error: $("screen-error")
    },
    startSummary: $("start-summary"),
    btnStart: $("btn-start"),
    counter: $("counter"),
    bloque: $("bloque"),
    timer: $("timer"),
    timerValue: $("timer-value"),
    progress: $("progress"),
    progressFill: $("progress-fill"),
    qbody: $("qbody"),
    question: $("question"),
    options: $("options"),
    feedback: $("feedback"),
    feedbackTitle: $("feedback-title"),
    feedbackText: $("feedback-text"),
    btnRetry: $("btn-retry"),
    btnNext: $("btn-next"),
    finalTitle: $("final-title"),
    finalScore: $("final-score"),
    finalOf: $("final-of"),
    finalMessage: $("final-message"),
    finalDetail: $("final-detail"),
    errorTitle: $("error-title"),
    errorText: $("error-text")
  };

  /* ================= Alias ================= */

  var ANIMALES = [
    "zorro", "lobo", "puma", "jaguar", "tigre", "oso", "nutria", "colibri",
    "buho", "halcon", "tortuga", "delfin", "ballena", "ajolote", "quetzal",
    "coyote", "venado", "iguana", "conejo", "ardilla", "pinguino", "llama",
    "tejon", "lince", "garza", "aguila", "cuervo", "castor", "flamenco", "pulpo"
  ];
  var ADJETIVOS = [
    "azul", "rojo", "verde", "dorado", "veloz", "sabio", "valiente", "tranquilo",
    "curioso", "brillante", "audaz", "alegre", "astuto", "sereno", "gris",
    "plateado", "nocturno", "agil", "fuerte", "amable", "callado", "atento"
  ];

  function randInt(max) {
    if (window.crypto && window.crypto.getRandomValues) {
      var buf = new Uint32Array(1);
      window.crypto.getRandomValues(buf);
      return buf[0] % max;
    }
    return Math.floor(Math.random() * max);
  }

  function newAlias() {
    for (var i = 0; i < 20; i++) {
      var nn = String(randInt(100));
      if (nn.length < 2) nn = "0" + nn;
      var a = ANIMALES[randInt(ANIMALES.length)] + "-" + ADJETIVOS[randInt(ADJETIVOS.length)] + "-" + nn;
      if (ALIAS_RE.test(a)) return a;
    }
    return "zorro-azul-42";
  }

  function getAlias() {
    var stored = null;
    try { stored = window.localStorage.getItem(ALIAS_KEY); } catch (e) { stored = null; }
    if (stored && ALIAS_RE.test(stored)) return stored;
    var fresh = newAlias();
    try { window.localStorage.setItem(ALIAS_KEY, fresh); } catch (e) { /* sin almacenamiento: alias solo de sesión */ }
    return fresh;
  }

  var ALIAS = getAlias();
  el.alias.textContent = ALIAS;
  el.aliasWrap.hidden = false;

  /* ================= Estado ================= */

  var state = {
    questions: [],
    idx: 0,
    results: [],      // por pregunta: "ok" | "bad" | "queued" | "dup" | "timeout" | "error"
    locked: false,    // ya se eligió o se acabó el tiempo
    sending: false,
    chosen: 0,
    deadline: 0,
    timerId: 0,
    retryTimerId: 0,
    controller: null
  };

  /* ================= Pantallas ================= */

  function show(name) {
    Object.keys(el.screens).forEach(function (k) {
      el.screens[k].hidden = (k !== name);
    });
    var s = el.screens[name];
    if (!reducedMotion()) {
      s.classList.remove("is-entering");
      void s.offsetWidth;
      s.classList.add("is-entering");
    }
  }

  function fatal(title, text) {
    stopTimer();
    el.errorTitle.textContent = title;
    el.errorText.textContent = text;
    show("error");
    el.errorTitle.focus();
  }

  /* ================= Carga de preguntas ================= */

  function validQuestion(q) {
    return q && typeof q === "object" &&
      typeof q.id === "string" && q.id.length > 0 &&
      typeof q.q === "string" && q.q.length > 0 &&
      Array.isArray(q.a) && q.a.length === 4 &&
      q.a.every(function (x) { return typeof x === "string" && x.length > 0; });
  }

  function parseRange(total) {
    var desde = parseInt(params.get("desde"), 10);
    var hasta = parseInt(params.get("hasta"), 10);
    if (!isFinite(desde) || desde < 1) desde = 1;
    if (!isFinite(hasta) || hasta > total) hasta = total;
    return { desde: desde, hasta: hasta };
  }

  function load() {
    fetch("questions.json", { cache: "no-cache", credentials: "omit" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) throw new Error("formato");
        var valid = data.filter(validQuestion).map(function (q) {
          var t = Number(q.t);
          return {
            id: q.id,
            bloque: typeof q.bloque === "string" ? q.bloque : "",
            q: q.q,
            a: q.a.slice(0, 4),
            t: isFinite(t) && t > 0 ? Math.round(t) : 30
          };
        });
        if (valid.length !== data.length) {
          console.warn("Se omitieron " + (data.length - valid.length) + " preguntas con formato inválido.");
        }
        if (!valid.length) throw new Error("vacío");

        var r = parseRange(valid.length);
        if (r.desde > r.hasta) {
          fatal("Rango de preguntas inválido",
            "Revisa los parámetros ?desde= y ?hasta= del enlace: hay " + valid.length + " preguntas disponibles.");
          return;
        }
        state.questions = valid.slice(r.desde - 1, r.hasta);
        state.results = state.questions.map(function () { return null; });

        var n = state.questions.length;
        el.startSummary.textContent = n === 1
          ? "Vas a contestar 1 pregunta de opción múltiple."
          : "Vas a contestar " + n + " preguntas de opción múltiple.";
        show("start");
        el.btnStart.focus();
      })
      .catch(function () {
        fatal("No se pudo cargar el quiz",
          "No encontramos las preguntas. Si abriste el archivo directamente, sírvelo desde un servidor web; si no, recarga la página en unos momentos.");
      });
  }

  /* ================= Temporizador ================= */

  function fmt(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function startTimer(seconds) {
    stopTimer();
    state.deadline = Date.now() + seconds * 1000;
    el.timer.classList.remove("is-low", "is-stopped");
    tick();
    state.timerId = window.setInterval(tick, 200);
  }

  function stopTimer() {
    if (state.timerId) window.clearInterval(state.timerId);
    state.timerId = 0;
    el.timer.classList.add("is-stopped");
  }

  function tick() {
    var left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    el.timerValue.textContent = fmt(left);
    el.timer.setAttribute("aria-label", "Tiempo restante: " + left + " segundos");
    el.timer.classList.toggle("is-low", left <= LOW_TIME_S && left > 0);
    if (left === 0) onTimeout();
  }

  function onTimeout() {
    stopTimer();
    el.timer.classList.remove("is-low");
    if (state.locked) return;
    state.locked = true;
    state.results[state.idx] = "timeout";
    setOptionsDisabled(true);
    markAll("is-dim");
    feedback("warn", "⏱ Se acabó el tiempo", "Esta pregunta queda sin respuesta.");
    showNext();
  }

  /* ================= Render de pregunta ================= */

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function updateProgress(done) {
    var total = state.questions.length;
    var pct = total ? Math.round((done / total) * 100) : 0;
    el.progressFill.style.width = pct + "%";
    el.progress.setAttribute("aria-valuenow", String(pct));
    el.progress.setAttribute("aria-valuetext", done + " de " + total + " preguntas completadas");
  }

  function buildOptions(q) {
    clear(el.options);
    el.options.classList.remove("is-sending");
    q.a.forEach(function (text, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option";
      btn.setAttribute("data-n", String(i + 1));

      var key = document.createElement("span");
      key.className = "option-key";
      key.setAttribute("aria-hidden", "true");
      key.textContent = String(i + 1);

      var label = document.createElement("span");
      label.className = "option-text";
      label.textContent = text;

      var tag = document.createElement("span");
      tag.className = "option-tag";

      btn.appendChild(key);
      btn.appendChild(label);
      btn.appendChild(tag);
      btn.addEventListener("click", function () { choose(i + 1); });
      el.options.appendChild(btn);
    });
  }

  function renderQuestion() {
    var q = state.questions[state.idx];
    var total = state.questions.length;
    state.locked = false;
    state.sending = false;
    state.chosen = 0;
    clearRetryCountdown();

    el.counter.textContent = "Pregunta " + (state.idx + 1) + " de " + total;
    el.bloque.textContent = q.bloque;
    el.bloque.hidden = !q.bloque;
    el.question.textContent = q.q;
    buildOptions(q);
    feedback(null);
    el.btnNext.hidden = true;
    el.btnRetry.hidden = true;
    updateProgress(state.idx);
    startTimer(q.t);
  }

  function goTo(index, focusQuestion) {
    var swap = function () {
      state.idx = index;
      renderQuestion();
      if (focusQuestion) el.question.focus();
    };

    if (reducedMotion()) { swap(); return; }

    el.qbody.classList.add("is-leaving");
    window.setTimeout(function () {
      swap();
      el.qbody.classList.remove("is-leaving");
      el.qbody.classList.add("is-entering");
      void el.qbody.offsetWidth;
      el.qbody.classList.remove("is-entering");
    }, 140);
  }

  /* ================= Retroalimentación ================= */

  function feedback(kind, title, text) {
    el.feedback.classList.remove("is-ok", "is-bad", "is-warn", "is-info", "is-empty");
    if (!kind) {
      el.feedback.classList.add("is-empty");
      el.feedbackTitle.textContent = "";
      el.feedbackText.textContent = "";
      return;
    }
    el.feedback.classList.add("is-" + kind);
    el.feedbackTitle.textContent = title || "";
    el.feedbackText.textContent = text || "";
  }

  function optionButtons() {
    return Array.prototype.slice.call(el.options.querySelectorAll(".option"));
  }

  function setOptionsDisabled(disabled) {
    optionButtons().forEach(function (b) { b.disabled = disabled; });
  }

  function markAll(cls) {
    optionButtons().forEach(function (b) { b.classList.add(cls); });
  }

  function setTag(btn, text) {
    var tag = btn.querySelector(".option-tag");
    if (tag) tag.textContent = text;
  }

  function showNext() {
    var last = state.idx >= state.questions.length - 1;
    el.btnNext.textContent = last ? "Ver resultados" : "Siguiente";
    el.btnNext.hidden = false;
    el.btnNext.focus();
  }

  /* ================= Envío ================= */

  function choose(n) {
    if (state.locked || state.sending) return;
    if (n < 1 || n > 4) return;
    state.locked = true;
    state.chosen = n;
    stopTimer();

    var btns = optionButtons();
    btns.forEach(function (b) {
      b.disabled = true;
      if (Number(b.getAttribute("data-n")) === n) {
        b.classList.add("is-chosen");
        b.setAttribute("aria-pressed", "true");
        setTag(b, "Tu respuesta");
      } else {
        b.classList.add("is-dim");
      }
    });

    send();
  }

  function apiConfigured() {
    return API_URL && API_URL.indexOf("REEMPLAZA") === -1;
  }

  function send() {
    var q = state.questions[state.idx];
    var sentIdx = state.idx;
    el.btnRetry.hidden = true;
    clearRetryCountdown();

    if (!apiConfigured()) {
      state.results[sentIdx] = "error";
      feedback("warn", "Falta configurar el servidor",
        "La página no tiene la dirección de la API. Avisa a tu docente; tu respuesta no se envió.");
      showNext();
      return;
    }

    state.sending = true;
    el.options.classList.add("is-sending");
    feedback("info", "Enviando tu respuesta…", "");

    var controller = window.AbortController ? new AbortController() : null;
    state.controller = controller;
    var timeoutId = window.setTimeout(function () { if (controller) controller.abort(); }, REQUEST_TIMEOUT_MS);

    var body = JSON.stringify({ pregunta_id: q.id, opcion: state.chosen, alias: ALIAS });

    fetch(API_URL, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: body,
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        return readJson(res).then(function (data) { return { status: res.status, data: data, res: res }; });
      })
      .then(function (r) {
        if (sentIdx !== state.idx) return; // el usuario ya avanzó
        handleResponse(r.status, r.data, r.res);
      })
      .catch(function (err) {
        if (sentIdx !== state.idx) return;
        var aborted = err && err.name === "AbortError";
        state.results[sentIdx] = "error";
        feedback("warn",
          aborted ? "El servidor tardó demasiado" : "Sin conexión con el servidor",
          "Revisa tu internet y vuelve a intentar. Tu opción sigue seleccionada.");
        offerRetry(0);
        showNext();
      })
      .then(function () {
        window.clearTimeout(timeoutId);
        if (sentIdx === state.idx) {
          state.sending = false;
          el.options.classList.remove("is-sending");
        }
      });
  }

  function readJson(res) {
    return res.text().then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    }).catch(function () { return null; });
  }

  function safeText(v, max) {
    if (typeof v !== "string") return "";
    v = v.trim();
    return v.length > max ? v.slice(0, max) + "…" : v;
  }

  function handleResponse(status, data, res) {
    var i = state.idx;
    data = data && typeof data === "object" ? data : {};

    if (status === 200) {
      showResult(data);
      showNext();
      return;
    }
    if (status === 202) {
      state.results[i] = "queued";
      feedback("info", "✓ Respuesta recibida",
        "Quedó en cola para calificarse. Puedes continuar con la siguiente pregunta.");
      showNext();
      return;
    }
    if (status === 400) {
      state.results[i] = "error";
      var msg = safeText(data.error, 300);
      feedback("bad", "✗ La respuesta no es válida",
        msg ? "El servidor dice: " + msg : "El servidor rechazó la solicitud. Avisa a tu docente.");
      showNext();
      return;
    }
    if (status === 403) {
      state.results[i] = "error";
      feedback("bad", "✗ Acceso denegado",
        "La llave de acceso de esta página no es válida. Avisa a tu docente; tu respuesta no se registró.");
      showNext();
      return;
    }
    if (status === 409) {
      state.results[i] = "dup";
      feedback("info", "Ya habías respondido esta pregunta",
        "Solo cuenta la primera respuesta registrada con tu alias.");
      showNext();
      return;
    }
    if (status === 429) {
      state.results[i] = "error";
      var wait = parseInt(res && res.headers ? res.headers.get("Retry-After") : "", 10);
      if (!isFinite(wait) || wait < 1 || wait > 60) wait = 5;
      feedback("warn", "Demasiadas solicitudes",
        "El servidor está muy ocupado. Espera unos segundos y vuelve a intentar.");
      offerRetry(wait);
      showNext();
      return;
    }
    state.results[i] = "error";
    feedback("warn", "El servidor tuvo un problema",
      "Respondió con el código " + status + ". Intenta de nuevo en un momento.");
    offerRetry(0);
    showNext();
  }

  function correctIndex(v) {
    var n = typeof v === "number" ? v : (typeof v === "string" && /^\s*[1-4]\s*$/.test(v) ? Number(v) : NaN);
    return n >= 1 && n <= 4 ? n : 0;
  }

  function showResult(data) {
    var i = state.idx;
    var hit = data.acierto === true;
    var ci = correctIndex(data.correcta);
    var q = state.questions[i];
    state.results[i] = hit ? "ok" : "bad";

    optionButtons().forEach(function (b) {
      var n = Number(b.getAttribute("data-n"));
      b.classList.remove("is-chosen");
      if (n === state.chosen) {
        b.classList.add(hit ? "is-correct" : "is-wrong");
        setTag(b, hit ? "✓ Correcta" : "✗ Tu respuesta");
      } else if (n === ci && !hit) {
        b.classList.add("is-correct");
        setTag(b, "✓ Correcta");
      }
    });

    var expl = safeText(data.explicacion, 1200);
    var text = expl;
    if (!hit) {
      var correctText = ci ? q.a[ci - 1] : safeText(data.correcta, 300);
      if (correctText) text = "La respuesta correcta es: " + correctText + "." + (expl ? " " + expl : "");
    }
    feedback(hit ? "ok" : "bad", hit ? "✓ ¡Correcto!" : "✗ Incorrecto", text);
  }

  /* ================= Reintento ================= */

  function clearRetryCountdown() {
    if (state.retryTimerId) window.clearInterval(state.retryTimerId);
    state.retryTimerId = 0;
    el.btnRetry.disabled = false;
    el.btnRetry.textContent = "Reintentar envío";
  }

  function offerRetry(waitSeconds) {
    clearRetryCountdown();
    el.btnRetry.hidden = false;
    if (!waitSeconds) return;
    var left = waitSeconds;
    el.btnRetry.disabled = true;
    el.btnRetry.textContent = "Reintentar en " + left + " s";
    state.retryTimerId = window.setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearRetryCountdown();
      } else {
        el.btnRetry.textContent = "Reintentar en " + left + " s";
      }
    }, 1000);
  }

  /* ================= Navegación ================= */

  function next() {
    if (state.controller && state.sending) {
      try { state.controller.abort(); } catch (e) { /* nada */ }
    }
    if (state.results[state.idx] === null) state.results[state.idx] = "error";
    if (state.idx >= state.questions.length - 1) {
      finish();
    } else {
      goTo(state.idx + 1, true);
    }
  }

  function finish() {
    stopTimer();
    clearRetryCountdown();
    updateProgress(state.questions.length);

    var total = state.questions.length;
    var count = function (k) { return state.results.filter(function (r) { return r === k; }).length; };
    var ok = count("ok");
    var bad = count("bad");
    var graded = ok + bad;
    var queued = count("queued");
    var timeout = count("timeout");
    var dup = count("dup");
    var errors = count("error");

    el.finalScore.textContent = String(ok);
    el.finalOf.textContent = (ok === 1 ? "acierto" : "aciertos") + " de " + total;

    var ratio = total ? ok / total : 0;
    var msg;
    if (graded === 0 && queued > 0) msg = "Tus respuestas se registraron y se calificarán en breve.";
    else if (ratio >= 0.9) msg = "¡Excelente! Dominas el tema.";
    else if (ratio >= 0.7) msg = "¡Muy bien! Vas por buen camino.";
    else if (ratio >= 0.5) msg = "Bien. Repasa las explicaciones de las que fallaste.";
    else msg = "Sigue practicando: revisa el material y vuelve a intentarlo.";
    el.finalMessage.textContent = msg;

    var parts = [];
    if (bad) parts.push(bad + (bad === 1 ? " incorrecta" : " incorrectas"));
    if (queued) parts.push(queued + " en cola de calificación");
    if (timeout) parts.push(timeout + " sin responder por tiempo");
    if (dup) parts.push(dup + (dup === 1 ? " ya respondida antes" : " ya respondidas antes"));
    if (errors) parts.push(errors + (errors === 1 ? " no se pudo enviar" : " no se pudieron enviar"));
    el.finalDetail.textContent = parts.length ? "Detalle: " + parts.join(", ") + "." : "";

    show("final");
    el.finalTitle.focus();
  }

  /* ================= Eventos ================= */

  el.btnStart.addEventListener("click", function () {
    show("quiz");
    state.idx = 0;
    renderQuestion();
    el.question.focus();
  });

  el.btnNext.addEventListener("click", next);

  el.btnRetry.addEventListener("click", function () {
    if (!state.chosen || state.sending || el.btnRetry.disabled) return;
    send();
  });

  document.addEventListener("keydown", function (e) {
    if (el.screens.quiz.hidden) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key >= "1" && e.key <= "4" && e.key.length === 1) {
      if (!state.locked && !state.sending) {
        e.preventDefault();
        choose(Number(e.key));
      }
    }
  });

  load();
})();
