# Working on this project

Instructions for Claude. These are the user's own standing rules, moved out of
one machine's memory and into the repo so they survive a change of account or
machine. They are not suggestions.

## Keep replies short

Answer in a few lines. Lead with the one thing that changed, or the one answer
to the question, and stop. No measurement tables in chat, no lists of what was
tried, no recaps.

Said outright: *"I basically never read all the stuff you say... sometimes I
can't be bothered."* Long replies were being skipped entirely, so the detail was
reaching nobody.

Put the reasoning and the numbers in the **commit message** and the **README**,
where they are searchable and where this project keeps them. In chat, give the
verdict. If they ask why, then explain. Still report failures plainly — brevity
is not the same as only sharing good news.

## Push when done

Commit **and push** as part of finishing a piece of work. Do not commit and then
wait to be told; they were saying "push it" after every single change and the
asking was pure friction.

A push fires the GitHub Actions deploy, so it reaches the live Azure app. That
is wanted. Still say what went up.

This covers ordinary finished work. It is not licence for force-pushes, history
rewrites, or pushing something that has not been checked.

## Never incur Azure costs

*"Please ensure that none of your actions ever incur costs on Azure."* The
account is personal, the site is a toy, and the Free (F1) plan was chosen
deliberately.

Deploy to the existing free resources, read them, change their settings. **Never**
create a resource, scale up or out, change a SKU or App Service plan, or enable
Always On, Application Insights, Log Analytics, staging slots, or custom
domains/certificates. If a task seems to need one, stop and ask.

Free-tier quotas (F1: 60 CPU-minutes a day) are not charges, but say when an
action will eat them — a server-side build does.

## How work is done here

This project has a measurement culture, and it is the reason it is any good.
Keep it.

* **Measure, do not reason.** Almost every tuning instinct recorded in the
  README was wrong when measured. If you change a number, run a rig and get a
  figure before and after.
* **The rigs are in `tests/`** and run in the browser, not in node. See
  HANDOVER.md for how to drive them.
* **Compare like with like.** Two settings measured back-to-back in one page
  session cannot be compared — batches carry damage and debris forward, and
  whichever runs second looks worse regardless. Reload between them and compare
  first-batch to first-batch. This has produced at least two false conclusions
  already.
* **Write the numbers down** in the commit message and the README, including the
  negatives. "I tried this and it measured worse" is worth as much as a fix, and
  this repo has a lot of it. Do not quietly drop a failed attempt.
* **Quote the player.** The README and the comments quote what they actually
  said about a bug. It is how the intent survives, and it dates well.
* **Keep `HANDOVER.md` current.** It is written for a Claude who arrives with no
  conversation history, and it goes stale the moment it stops matching the
  code. Update it as part of finishing a piece of work -- not every commit, but
  whenever something in it stops being true: a mode added, an open problem
  solved or found, a trap discovered, a decision the user made that should not
  be undone later. The user asked for this explicitly, to keep it useful for
  whoever picks the project up next.
