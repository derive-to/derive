export function HowItWorks() {
  return (
    <section data-testid="how-it-works" className="mt-8">
      <h2 className="font-serif text-xl font-medium tracking-tight text-balance text-foreground">
        Keep useful work visible
      </h2>
      <p className="mt-1.5 max-w-2xl text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
        Publish what should outlast the session. You can keep it private, share it, or update it
        later.
      </p>

      <dl className="mt-5 grid gap-5 sm:grid-cols-3 sm:gap-8">
        <Step
          title="Publish the result"
          blurb="Give a report, plan, deck, or site a lasting URL outside the chat."
        />
        <Step
          title="Find the current work"
          blurb="Open the latest version without searching through an old conversation."
        />
        <Step
          title="Discuss and update"
          blurb="Leave comments, then publish a new version to the same URL."
        />
      </dl>
    </section>
  )
}

function Step({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <dt className="text-sm font-medium text-foreground">{title}</dt>
      <dd className="mt-1.5 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">{blurb}</dd>
    </div>
  )
}
