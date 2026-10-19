import { renderVisualFrameHtml, validateVisuals } from "../../lib/render.js";

export function mountVisualPlayers(container, visuals) {
  const players = [];
  if (visuals?.length && validateVisuals(visuals).length === 0) {
    for (const figure of container.querySelectorAll("[data-visual-id]")) {
      const visual = visuals.find(item => item.id === figure.dataset.visualId);
      if (visual) players.push(createPlayer(figure, visual));
    }
  }
  return {
    pause() { players.forEach(player => player.pause()); },
    destroy() { players.splice(0).forEach(player => player.destroy()); }
  };
}

function createPlayer(figure, visual) {
  const frame = figure.querySelector("[data-visual-frame]");
  const controls = document.createElement("div");
  controls.className = "visual-controls";
  const condition = document.createElement("label");
  condition.className = "field visual-condition";
  const label = document.createElement("span");
  label.textContent = "조건";
  const select = document.createElement("select");
  for (const scenario of visual.scenarios) {
    const option = document.createElement("option");
    option.value = scenario.id;
    option.textContent = scenario.label;
    select.append(option);
  }
  condition.append(label, select);
  const actions = document.createElement("div");
  actions.className = "visual-actions";
  const previous = controlButton("이전 단계");
  const play = controlButton("재생");
  const next = controlButton("다음 단계");
  const reset = controlButton("처음으로");
  actions.append(previous, play, next, reset);
  const status = document.createElement("p");
  status.className = "visual-status";
  status.setAttribute("role", "status");
  const hint = document.createElement("p");
  hint.className = "visual-hint";
  hint.textContent = "단계 이동: ← → · 처음/마지막: Home/End · 재생/멈춤: Space. 재생은 직접 시작할 때만 진행됩니다.";
  controls.append(condition, actions, status, hint);
  figure.querySelector("figcaption").after(controls);
  figure.tabIndex = 0;
  figure.setAttribute("aria-label", `${visual.title} 단계 탐색`);
  figure.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Home End Space");
  const events = new AbortController();
  let scenarioIndex = 0;
  let stepIndex = 0;
  let timer = null;

  function scenario() { return visual.scenarios[scenarioIndex]; }

  function update() {
    frame.innerHTML = renderVisualFrameHtml(scenario().steps[stepIndex]);
    previous.disabled = stepIndex === 0;
    next.disabled = stepIndex === scenario().steps.length - 1;
    play.disabled = scenario().steps.length === 1;
    play.textContent = timer === null ? "재생" : "일시정지";
    play.setAttribute("aria-pressed", String(timer !== null));
    status.textContent = `${scenario().label} · ${stepIndex + 1} / ${scenario().steps.length} 단계 · ${timer === null ? "일시정지됨" : "재생 중"}`;
  }

  function pause() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    update();
  }

  function move(index) {
    pause();
    stepIndex = Math.max(0, Math.min(scenario().steps.length - 1, index));
    update();
  }

  function togglePlay() {
    if (scenario().steps.length <= 1) return;
    if (timer !== null) return pause();
    if (stepIndex === scenario().steps.length - 1) stepIndex = 0;
    timer = setInterval(() => {
      stepIndex += 1;
      if (stepIndex === scenario().steps.length - 1) pause();
      else update();
    }, 1600);
    update();
  }

  const signal = events.signal;
  previous.addEventListener("click", () => move(stepIndex - 1), { signal });
  next.addEventListener("click", () => move(stepIndex + 1), { signal });
  reset.addEventListener("click", () => move(0), { signal });
  play.addEventListener("click", togglePlay, { signal });
  select.addEventListener("change", () => {
    pause();
    scenarioIndex = visual.scenarios.findIndex(item => item.id === select.value);
    stepIndex = 0;
    update();
  }, { signal });
  figure.addEventListener("keydown", event => {
    if (event.target !== figure || event.altKey || event.ctrlKey || event.metaKey) return;
    const actions = { ArrowLeft: () => move(stepIndex - 1), ArrowRight: () => move(stepIndex + 1), Home: () => move(0), End: () => move(scenario().steps.length - 1), " ": togglePlay };
    if (!actions[event.key]) return;
    event.preventDefault();
    actions[event.key]();
  }, { signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); }, { signal });
  update();
  return {
    pause,
    destroy() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      events.abort();
      controls.remove();
      figure.removeAttribute("tabindex");
      figure.removeAttribute("aria-label");
      figure.removeAttribute("aria-keyshortcuts");
    }
  };
}

function controlButton(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button";
  button.textContent = text;
  return button;
}
