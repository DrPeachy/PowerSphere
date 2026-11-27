<script lang="ts">
  let { timezone = "local" }: { timezone?: string } = $props();

  let now = $state(Date.now());

  $effect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const align = setTimeout(() => {
      now = Date.now();
      interval = setInterval(() => {
        now = Date.now();
      }, 1000);
    }, 1000 - (Date.now() % 1000));
    return () => {
      clearTimeout(align);
      if (interval) {
        clearInterval(interval);
      }
    };
  });

  let formatter = $derived(buildFormatter(timezone));
  let text = $derived(formatter.format(new Date(now)));

  function buildFormatter(zone: string): Intl.DateTimeFormat {
    const options: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    };
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        ...options,
        timeZone: zone === "local" ? undefined : zone,
      });
    } catch {
      return new Intl.DateTimeFormat("zh-CN", options);
    }
  }
</script>

<time class="clock-time">{text}</time>
