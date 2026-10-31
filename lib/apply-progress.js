/**
 * Apply / 복원 / 제거의 메모리 진행 상태.
 * /dsh-purge/status 폴링 전용이며 디스크에 쓰지 않고 gatherState 에도 들어가지 않는다.
 */
const IDLE = Object.freeze({
  active: false,
  kind: "apply",
  stage: "idle",
  detail: "",
  applied: 0,
  total: 0,
  error: "",
  startedAt: 0,
  updatedAt: 0,
});

let current = { ...IDLE };

export function getApplyProgress() {
  return { ...current };
}

export function beginJob(kind = "apply", stage = "home") {
  const now = Date.now();
  current = {
    active: true,
    kind,
    stage,
    detail: "",
    applied: 0,
    total: 0,
    error: "",
    startedAt: now,
    updatedAt: now,
  };
  return getApplyProgress();
}

export function beginApply(stage = "home") {
  return beginJob("apply", stage);
}

export function setApplyProgress(patch = {}) {
  current = {
    ...current,
    ...patch,
    active: patch.active == null ? true : Boolean(patch.active),
    updatedAt: Date.now(),
  };
  return getApplyProgress();
}

export function endApply(patch = {}) {
  current = {
    ...current,
    ...patch,
    active: false,
    updatedAt: Date.now(),
  };
  return getApplyProgress();
}

export function resetApplyProgress() {
  current = { ...IDLE, updatedAt: Date.now() };
  return getApplyProgress();
}
