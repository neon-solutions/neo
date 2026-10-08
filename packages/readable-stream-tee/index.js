// The scriptc --dynamic island ships a ReadableStream whose tee() throws, and the AI SDK's
// streamText tees its base stream for every consumer (text, fullStream, consumeStream).
// This module runs inside the island because it is an npm package; neo's own code compiles
// statically and cannot patch island globals.

function teeIsSupported() {
  try {
    new ReadableStream().tee();
    return true;
  } catch {
    return false;
  }
}

function tee() {
  const reader = this.getReader();
  let canceled1 = false;
  let canceled2 = false;
  let reason1;
  let reason2;
  let controller1;
  let controller2;
  let inflight = null;
  let resolveCancel;
  const cancelPromise = new Promise((resolve) => {
    resolveCancel = resolve;
  });

  // Both branches share one in-flight read: the island re-pulls whenever a branch queue is
  // empty after pull() settles, so pull() must not settle before that read delivers.
  const pull = () => {
    if (inflight !== null) {
      return inflight;
    }
    inflight = reader.read().then(
      ({ value, done }) => {
        inflight = null;
        if (done) {
          if (!canceled1) controller1.close();
          if (!canceled2) controller2.close();
          resolveCancel();
          return;
        }
        if (!canceled1) controller1.enqueue(value);
        if (!canceled2) controller2.enqueue(value);
      },
      (error) => {
        inflight = null;
        controller1.error(error);
        controller2.error(error);
        resolveCancel();
      },
    );
    return inflight;
  };

  const cancelSource = () => {
    reader.cancel([reason1, reason2]).then(resolveCancel, resolveCancel);
  };

  const branch1 = new ReadableStream({
    start(controller) {
      controller1 = controller;
    },
    pull,
    cancel(reason) {
      canceled1 = true;
      reason1 = reason;
      if (canceled2) cancelSource();
      return cancelPromise;
    },
  });
  const branch2 = new ReadableStream({
    start(controller) {
      controller2 = controller;
    },
    pull,
    cancel(reason) {
      canceled2 = true;
      reason2 = reason;
      if (canceled1) cancelSource();
      return cancelPromise;
    },
  });
  return [branch1, branch2];
}

if (!teeIsSupported()) {
  ReadableStream.prototype.tee = tee;
}
