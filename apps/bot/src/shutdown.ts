/** End callbacks must finish recording before the stores are closed. */
export function createShutdown(options: {
  stop: () => void;
  quit: () => void;
  timeout: () => void;
  detach: () => void;
  closeStores: () => Promise<void>;
  timeoutMs?: number;
}) {
  let closing: Promise<void> | undefined;
  let ended = false;
  let signalEnd!: () => void;
  const end = new Promise<void>((resolve) => {
    signalEnd = resolve;
  });
  return {
    markEnded() {
      if (!ended) {
        ended = true;
        signalEnd();
      }
    },
    shutdown(quit: boolean): Promise<void> {
      if (!closing)
        closing = Promise.resolve().then(async () => {
          try {
            options.stop();
            if (quit && !ended) options.quit();
            if (!ended) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const completed = await Promise.race([
                  end.then(() => true),
                  new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), options.timeoutMs ?? 5000);
                  }),
                ]);
                if (!completed) options.timeout();
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
          } finally {
            options.detach();
            await options.closeStores();
          }
        });
      return closing;
    },
  };
}
