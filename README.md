# Police Chase

A 3D police pursuit game. You are the escapee; the police coordinate to stop you.

Runs in the browser on **three.js** (rendering) and **Rapier** (rigid-body physics),
both vendored locally in `vendor/` so the game works offline. No build step, no
Node, no bundler — the browser loads the ES modules directly. All sound is
synthesised at runtime, so there are no audio files either.

---

## Running it

```bash
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

That starts a small static server (built on .NET's `HttpListener`, so nothing to
install) and opens the game. Use `-Port 9000` to change the port, `-NoBrowser`
to skip opening a window.

The files **must** be served over HTTP. Opening `index.html` from disk will not
work — browsers refuse ES module imports and WASM loads on `file://`.

**Ctrl+C** stops the server. If you ever need to kill one from elsewhere, note
that the listening port belongs to the kernel's HTTP.sys driver, not to
PowerShell — looking up the port owner gives you PID 4 (System). Find it by
command line instead:

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*serve.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Multiplayer

One player runs; everyone else is a police car, alongside the AI.

The menu offers three ways in: **SINGLE PLAYER**, **HOST A GAME** and **JOIN A
GAME**. Hosting asks for a name for the game and then the same three questions
single player asks — car, weather, ground — because the host is the escapee and
what they pick is what everybody plays. Joining asks for that name and one
thing more: which police car you turn up in. It does not show a map, because
the map is not yours to choose; it used to show one greyed out, which looked
broken rather than settled. There is no lobby to browse and nothing to sign
into — the name is the whole of it.

**Nothing starts until START is pressed.** Clicking a map used to start the
game on the spot, which meant you could not read what the second map was like
without playing it, and made hosting a game feel like it went off by accident.

A human police player drives a **pursuit car from the first star**, which an AI
unit would not get until three, and chooses which one on the way in. They are a
real unit as far as the rest of the game is concerned: the siren picks them up,
they show on the radar, and **they can make the arrest** — the bust clock is
heat.js measuring the gap to the nearest unit, and a human in a police car is a
unit like any other.

Measured on the car as a person gets it, not as the AI drives it
(`tests/policecars.js`; the escapee's three are in the table further down):

| | top speed | 0–60 | grip | shunts to wreck |
|---|---|---|---|---|
| **Interceptor** | 152 mph | 5.7 s | 1.52 g | 15 |
| **Police SUV** | 145 mph | 7.1 s | 1.53 g | 22 |

Shunts to wreck is hits from a *civilian* car. **One of your own costs a
third** — the same 50 km/h shunt does 2.6% to an interceptor when it comes
from a patrol car and 6.6% when it comes from a Runner, and the patrol car on
the other end of it takes 3.2% rather than 9.0%. As a police player you catch a
lot of those, because the pack is driving at the escapee and you are in the
way: *"the other police cars seem to do loads of damage"*. Two police cars
meeting is a paint swap and somebody's paperwork, not the end of either car,
and it applies both ways round so the pack does not wreck itself on you.

Two, and both marked. The rest of the fleet stays the AI's to drive: the patrol
car because, measured, it is slower than the interceptor, less grippy and no
tougher, so it was a choice nobody would make for a reason, and the unmarked
pursuit car because a police player turns up as a unit that has been sent, with
a light bar on the roof.

**The SUV turns at manoeuvring speed.** It is a long car on a small lock —
2.98 m of wheelbase turned by 0.55 radians — so getting it round a corner in a
town felt like a three point turn. Its own lock goes to 0.62, and its fronts
take a little more of the grip than its rears so the nose uses the extra lock
instead of pushing on (`tests/policeturn.js`, the `lock` set):

| full lock, radius | 20 km/h | 30 km/h | 50 km/h | 90 km/h |
|---|---|---|---|---|
| before | 5.0 m | 5.9 m | 15.5 m | 45.0 m |
| **now** | **4.4 m** | **5.5 m** | **14.3 m** | **42.3 m** |

Body slip is within a degree and a half of what it was at every one of those
speeds, so it turns tighter without being any looser, and more lock than this
only made the back end scrub. The AI's SUVs are untouched.

They are given a callsign, in the order they joined: the first police player is
**U1**, which the radio reads as "Unit one". Typing a name for yourself was
tried and taken out again — it is one more box to fill in before a game that is
meant to be a name and a button, and a callsign is what a unit has. The AI's
pool starts above the numbers held for players, so there is never a second U1;
on your own, with no players to hold numbers for, the AI starts at U1 as it
always did.

**Night and rain belong to the game, not to the player.** Whoever creates it
sets them and everyone else gets them, whatever their own menu says. They used
to be read from each machine separately, so the escapee could be out in the
rain at night while the police had a dry afternoon — and rain takes grip down
to 0.8 of dry, so the two of them were not even driving on the same roads.

**One radio net, not one each.** The chase is run on the escapee's machine, so
every line was said there and nowhere else: a police player heard their own
siren and silence, which is most of the radio missing. Lines now go out with
the rest of the traffic and are spoken on every machine at the same moment, in
the same voice each would have used. They are sent from the one place every
line already passes through, and a line that arrives is never sent on, so
nothing can echo round the room.

**The car is heavier than anything on the other side.** A quarter of a tonne
over the Runner was not enough to feel, because what moves a car in a contact
is momentum: it is now 1938 kg against the Runner's 1425, with the engine up
12% so the weight is not paid for in acceleration. Measured, pushing a Runner
that is standing on its brakes: 12.0 m in five seconds against the fleet car's
9.7, and it leaves them doing 17 km/h rather than 13. The handling is unchanged
— the numbers in the table above were re-measured with the extra weight.

### The car a person drives

Police cars are tuned for the AI, which plans its speed into a corner before it
arrives and never asks for more than it worked out it could have. A person
holds the wheel over and waits to see what happens, and in a stock interceptor
what happens is a slide: *"it's so hard to drive, honestly, it just slides."*

The difference is one setting. Both player cars carry a `highSpeedTyre` (see
"Grip at speed"), which stiffens the lateral curve above about 72 km/h so the
car points where it is going; the fleet has never had it, because nothing
driving those cars needed it. The car a human police player drives now gets the
Runner's version of it, as its own copy of the spec — same body, same model,
same engine — so every AI interceptor is untouched and the chase is unchanged.

Full lock held for two seconds, throttle on (`tests/highspeed.js`):

| body slip, mean / worst | 100 km/h | 140 km/h | 180 km/h |
|---|---|---|---|
| stock interceptor, as the AI drives it | 11.0° / 21.5° | 11.4° / 18.8° | 9.7° / 14.3° |
| **as a person drives it** | **0.4° / 0.8°** | **0.2° / 0.6°** | **0.6° / 1.3°** |
| the Runner, for comparison | 4.9° / 7.5° | 1.6° / 3.3° | 1.0° / 2.2° |

It also holds more grip while doing it — 1.37–1.47 g against 1.14–1.22.

**Where a chase actually happens is lower than that**, and the first attempt at
this matched the Runner exactly — which turned out to be aiming at the wrong
target, because the Runner is a handful too and that is the point of it. The
setting only came in from 72 km/h, so the whole 40–80 km/h band was still the
raw car. It now comes in from 29.

`tests/drivable.js` asks the three questions that spin a rear-drive car for
somebody holding a keyboard, where steering is all or nothing: hold full lock
at a steady speed, hold it and floor the throttle, hold it and lift off.

| at 60 km/h, body slip mean / worst | turn in | on the power | lifting off |
|---|---|---|---|
| the Runner | 3.2° / 4.9° | **8.5° / 18.6°**, and does not gather itself up | 2.1° / 5.0° |
| police car, first attempt | 1.0° / 1.8° | 3.2° / 5.6° | 3.2° / 6.2° |
| **police car, now** | **2.1° / 2.4°** | **1.7° / 2.1°** | **4.2° / 6.4°** |

At 80 km/h it is flatter still — 0.8° at full lock against the Runner's 7.4° —
and it keeps its speed through the corner rather than scrubbing it off: 75 km/h
out of 80, where the Runner leaves with 61.

Lifting off mid-corner at 40 km/h is the one thing still worth respecting —
about 10° of slip, which gathers itself up — and that is deliberate: the car
can still be rotated on purpose, and a handbrake turn is still a handbrake
turn.

#### Turning at chase speeds

*"At higher speeds — like fifty to a hundred — it needs to be slightly better
at turning."* Turning is not the same question as grip, and the grip was
already there: what a driver feels as a car that will not turn is the front
tyres giving up before the rears, so the nose runs wide of the lock they asked
for. The drivable spec's front grip was 1.15 against the rear's 1.25, which is
exactly that, on purpose — it is what kept the tail planted.

At 1.24 the two ends are almost even. Full lock, held at a steady speed
(`tests/policeturn.js`):

| | 50 km/h | 70 km/h | 90 km/h | 100 km/h |
|---|---|---|---|---|
| radius, before | 10.6 m | 21.9 m | 36.6 m | 43.9 m |
| **radius, now** | **10.3 m** | **19.7 m** | **30.6 m** | **36.4 m** |
| body slip, before / now | 4.9° / 5.0° | 1.4° / 1.5° | 0.5° / 0.5° | 0.3° / 0.2° |

A sixth off the circle at the top of that band, and the body is no more
sideways than it was at the bottom of it — it turns better without getting
loose. The three keyboard questions above are unmoved: turn-in at 60 km/h is
2.0° against 2.1°, on the power 1.6° against 1.7°, lifting off 4.4° against
4.2°, nothing spins and everything gathers itself up.

Two other ways in were tried and measured away. Stiffening the front made it
turn *worse* (90 km/h: 36.6 m → 37.9 m), and raising the steering limiter's
lateral target did nothing the tyre change had not already done.

Traction control was not the answer and is not part of this. Every car in the
game already has it (`makeSpec`, 0.85); turning it up moved wheelspin by four
hundredths on tarmac and on grass and body slip not at all. What the car was
short of was grip in the corner, not restraint on the throttle.

**It is not a slow car, and it is not meant to be.** A pursuit car that cannot
stay with the thing it is chasing is scenery: measured, the interceptor a
person drives tops 245 km/h against the Stiletto's 240, and since the front
tyres were evened up it holds 1.52 g against the Stiletto's 1.58 and the
Runner's 1.40. What it gives away is weight — it is half a tonne heavier than
the Runner, which is what makes a shove a shove — and, in the SUV, a second and
a half to sixty. None of this touches the AI's cars: every fleet interceptor is
the spec it always was, so a single-player chase is unchanged.

**Commentary needs somebody with eyes on.** Running a red light is called in
by the unit that saw it — within 120 m, with a clear line to the car — and when
there was nobody, the call fell back to whoever was primary, who then read out
a junction name from the other side of town while the entire force was
searching: *"they kept giving commentary, saying red light through Elmstown
Road, like they knew where I was."* The fallback now only stands in while the
force can actually see the car. The rest of the running commentary was already
gated this way.

### Seeing them, and losing them

A police player's radar shows the suspect **only while the pursuit can actually
see them**. The car is on their machine the whole time — it has to be, to be
driven past and crashed into — but knowing where it is has to be earned:
*"if the other person escapes the sight of the police officers, I can still see
them on the map… I should have to get closer to see them again."*

So the marker follows the same rules as the force's own knowledge: solid while
somebody has eyes on the car, then frozen at the last place it was seen and
**flashing** for the search window, then out altogether. Sight is the real
thing — range, and a line that a building blocks — and a human unit counts as a
spotter like any other, so driving closer is what brings the dot back.

**And only while there is a chase on.** With nobody wanted, the two of you are
just cars driving around a city and the force has no business knowing where the
other one is; the marker used to appear the moment the car came into view of
anything, which gave away somebody who had done nothing and was not being
looked for.

When they are past the edge of what the map shows — which in a chase is most of
the time — the marker is held against the rim as an **arrow pointing the way
they went**, so the map still answers "which way", and it flashes there too
once sight is lost.

### How it is put together

There is no server-side simulation. Every client runs the whole game, and each
one owns exactly the cars it drives:

* the **escapee owns the chase** — their machine runs the dispatcher, the AI
  cars, the heat, the roadblocks and the helicopter, because all of that is
  built around the car being chased, and broadcasts the result thirty times a
  second;
* each **police player owns their own interceptor** and broadcasts that.

Everything a client does not own arrives as packets and is **followed** by an
ordinary car with no engine or suspension of its own, whose velocity is set
each frame to run along the line those packets describe. The player who hits
somebody is the one whose physics decides what the hit felt like, so both cars
bounce on both screens without either side being able to push the other around.

They were kinematic bodies first, which is tidier — put the car where the
packet says and be done — until one touches you. A kinematic body has infinite
mass as far as the solver is concerned, so none of a collision goes into it and
all of it goes into you: an AI car clipping a stationary player at 54 km/h
threw them to **119 km/h** and did 42% damage, where the same hit from an
ordinary car gives 29 km/h and 7%. Following with velocity instead means the
car carries its real 1.7 tonnes into the contact and takes its share. Being
shoved off the line is allowed, and the pull that brings it back is capped
(10 m/s, 6 rad/s) precisely so that a car being leaned on gives way instead of
becoming a battering ram; more than five metres out and it is simply put where
it belongs. Within six metres of your own car the pull drops to a third of
that, because holding a car on its line while somebody leans on it is what made
a hit feel wrong — the car you hit carried on as though nothing had happened.
It gives way for the contact and catches up afterwards, which is what a car
does. Remote cars are drawn
90 ms behind the newest packet and interpolated between the two either side of
it — extrapolating all the time reads beautifully on a straight and badly
everywhere else, because a car that brakes hard carries on into the junction
and is then yanked back.

**Up close, that delay is dropped.** Ninety milliseconds at 80 km/h is two
metres, and two metres is the difference between a shunt and a miss: *"he hit
me, and on my screen he hit me from quite far away — like an in-game metre or
so — but on his screen it looked like he properly hit me."* Both machines drew
what they had; the one doing the hitting was looking at where the other car had
been. So the delay now eases off as a car comes near, and inside about seven
metres it is gone — the car is carried forward along its own velocity instead,
capped at 110 ms of guesswork. Measured, a car doing 80 km/h whose true
position is 0:

| distance away | 100 m | 40 m | 20 m | 5 m |
|---|---|---|---|---|
| drawn at | −1.97 m | −1.96 m | −1.08 m | **+0.02 m** |

The guess is only ever about a car a few metres away, travelling roughly the
way you are, over one packet's worth of time — which is a different thing from
predicting a car three streets off through a junction. The facing is left
alone: a heading does not run on in a straight line the way a position does.

**And a hit that arrives stale is dropped.** If the machine that reported it is
more than 14 m from the car it says it hit by the time the packet lands, it is
thrown away rather than shoving a car in front of somebody who saw nothing
touch it. Fourteen metres is deliberately generous — half a second at a closing
speed of 30 m/s — because hits that never registered at all were the complaint
before this one.

Cars on the wire are a list of numbers, not objects: position, rotation,
velocity, steering, speed, damage and a flags byte, rounded to centimetres --
about 80 bytes each, and a chase in progress measured 640 bytes a packet and
13 KB a second going up from the host. An AI car more than 400 m from every
human is not sent at all: it is a dot nobody can see, half the pack is usually
out there, and it comes back the moment somebody drives near it.

**A hit has to move the car as well as dent it.** The machine that did the
hitting sends the velocity change it measured, and the owner applies it to its
own copy — that part worked, and the damage landed. What did not is that the
car never went anywhere: ramming an AI patrol car as a police player wrote down
the dent on the escapee's machine while the car itself drove on, so on the
screen that did the hitting it was a car that would not budge. The hit now
carries the direction it went in as well, and the owner puts it through the
body as a real impulse, capped at 14 m/s so a bad frame cannot launch anybody.

**"a" is a letter players' ids start with.** Cars on the wire are told apart by
their id, and an AI car's used to be the letter *a* in front of its callsign
number, while a player's id is eight characters of `Math.random().toString(36)`
— so about **one player in thirty-six** was taken for an AI car by every
machine but their own. Their car was dropped from the world packet's
bookkeeping and blinked in and out on the other screens, they did not count as
somebody who could see a car appear, and a hit on them went looking for a
patrol car with their name on it. The marker is now `#`, which base 36 cannot
produce.

**Nothing appears or vanishes in front of anybody.** Every spawn already
checked that the escapee could not see the spot, and every retirement measured
its distance from the escapee — which in a game with other people in it is one
person out of however many are playing: *"I would see police cars just despawn
right in front of my eyes as a police officer."* Their cameras cannot be tested
from another machine, but their cars can, so anywhere within 170 m of another
player counts as in view, and the roster's distances are measured to the
**nearest person** rather than to the escapee. In a single player game that
list is empty and none of it changes anything.

**Two units, one parking space.** Each machine places its own car, so two
police players joining within a moment of each other both chose a spot knowing
only the cars they had heard about — and neither had heard about the other yet.
For the first six seconds after joining, if somebody else's car is within nine
metres, whoever has the higher id gives way and goes somewhere else. The ids
are the same strings on both machines, so exactly one of them moves.

**The arrest clock is on every screen.** It is measured on the escapee's
machine, because it is their car and their five seconds, so a police player
watching an arrest happen — even one they were making themselves — had no
meter at all. It goes out with the rest of the world state now.

`RemoteUnit` (in `main.js`) is what makes the rest of the game work without
knowing any of this: a police car somebody else drives is registered with the
dispatcher as a unit that takes no orders, so the siren, the radar and the
arrest all read it the way they read an AI one. The dispatcher skips `human`
units when it hands out roles and when it thins the roster, so a player is
never told to run a PIT or despawned for being too far away.

### The server, and testing it without one

`server/Program.cs` serves the game and relays packets at `/ws`; `Rooms.cs` is
the room list. It never looks inside a packet — it remembers who is in which
game, tells a newcomer which map is being played, and passes bytes on. A relay
is about all a Free plan's CPU quota would thank you for anyway, and WebSockets
have to be switched on for the site (the deploy script does it; it is a setting,
not a tier).

Multiplayer can also be played, and tested, with **no server at all**: with
`?net=local` the transport is a `BroadcastChannel` instead of a WebSocket, so
two tabs of the same browser are two players, against the static dev server.
The protocol above it is identical, which is how the whole of it — create,
join, world sync, an arrest by a human police car — was tested before it was
ever deployed.

### Endings, and what is not one

Being arrested is an ending **for everybody in the game**: the escapee gets the
full curtain, the score and "press R", and a police player gets a notice saying
so, with their car pinned shut exactly as the escapee's is. It used to leave
them driving — *"even though it says the subject has been busted, you can still
drive around"* — which is not an ending, it is a screensaver. Starting again is
still the escapee's call, and the restart releases everyone.

**Getting away is not an ending for anybody.** The escapee's banner says so for
a few seconds and they drive on, and the police now get the same banner from
the other side rather than a full-screen "play again" they could not act on:
*"the police car has this big thing comes up… but it doesn't work because the
host is free roaming."* Starting a fresh run is the escapee's to do, so R does
nothing on a police player's machine and the overlay no longer offers it.

### What it does not do

Nothing is smoothed over if the network stalls; a packet that does not arrive
means a car that holds its last known line. There is no reconnection: a refresh
is a new player. If the escapee leaves, the game is over for everyone in it,
which is said on screen rather than left to guess at. And the free plan allows
only a handful of WebSockets at once, so this is a game for a few friends, not
a public server.

## Putting it on the web

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-azure.ps1
```

That publishes the game, and the small ASP.NET server in `server/` that hosts
it, to the Azure Web App — a Free (F1) Linux plan running `DOTNETCORE|10.0`.
`az login` first; everything else has a default (subscription, resource group
and app name are the ones the site was created with, and can be overridden).

The server is `server/Program.cs`: about sixty lines of static file hosting,
because the game is entirely client side. What it is there for is the things a
naive file server gets wrong:

* **Content types.** A module served as `text/plain` is a blank screen, and
  Rapier's WebAssembly needs `application/wasm` to stream-compile. `.glb` for
  the car models is not in .NET's default list either.
* **Compression.** App Service does not compress for you, and three.js alone is
  3.7 MB of JavaScript. Brotli and gzip, at the fastest setting — CPU is the
  scarce thing on a free plan.
* **Caching.** `vendor/` and `resources/` for a week; the game's own code and
  page revalidate every time, so a deploy is live at once.
* **The port.** App Service tells the container which port to answer on with
  `PORT`. Ignore it and the platform's health check never gets a reply, which
  shows up as "Application Error" with an empty log.

### How it deploys, and why not the usual way

The site has basic publishing credentials switched off (`/ftp` and `/scm` both
`allow: false`), which is the sensible setting and rules out FTP, the publish
profile, and every "deployment password" path — including `az webapp
deployment source config-zip`. The free plan has no Git integration either.

So the script posts a zip to Kudu with a **Microsoft Entra** token from the
Azure CLI: `az account get-access-token`, then `POST /api/publish?type=zip`
with `Authorization: Bearer`. It asks Azure for the SCM host name rather than
assuming it, because a modern site's is `police-chase-c8c8bbdrbeg8cfcx.scm.
ukwest-01.azurewebsites.net` — the unique suffix and the region cannot be
guessed from the app name.

With a .NET 10 SDK installed it runs `dotnet publish` here and ships the
output. Without one it ships the sources and lets Azure's own build (Oryx)
compile them, which needs nothing installed locally — `-ServerBuild` forces
that either way. The upload is `clean=true`, so files deleted from the
repository disappear from the site instead of lingering, and the script waits
for the deployment to finish and then for the site to answer before it says it
is done.

`-IncludeTests` also publishes `tests/`, so the browser-console harnesses can
be run against the deployed site; they are left out by default.

### Deploying from GitHub

`.github/workflows/deploy.yml` does the same thing on every push to `master`:
stages the game into the server's `wwwroot`, builds it with the .NET 10 SDK on
the runner, publishes it to the Web App, and waits for the site to answer
before calling the run green. It replaced a Static Web Apps workflow — that
service serves files, and multiplayer needs a server to relay through.

It signs in with **Microsoft Entra over OIDC**, not a publish profile: basic
publishing credentials are off on this site, and OIDC means nothing
long-lived is stored in the repository at all. That needs a one-time setup —
an app registration GitHub is allowed to impersonate, and permission for it on
the one web app. Nothing here is billable: an app registration, a federated
credential and a role assignment are all free.

```bash
az ad app create --display-name police-chase-deploy --query appId -o tsv
```

With that `appId`:

```bash
az ad sp create --id <appId>
```

```bash
az role assignment create --assignee <appId> --role "Website Contributor" --scope /subscriptions/0dc4d6c9-9c1f-493e-b13c-18bcf67c0749/resourceGroups/police-chase/providers/Microsoft.Web/sites/police-chase
```

```bash
az ad app federated-credential create --id <appId> --parameters '{"name":"github-master","issuer":"https://token.actions.githubusercontent.com","subject":"repo:lordvacuum5/police-chase:ref:refs/heads/master","audiences":["api://AzureADTokenExchange"]}'
```

**GitHub may present an immutable subject instead**, with the numeric owner and
repository ids in it rather than their names — which is the same identity said
a different way, and does not match the credential above. The first run said
so, at length:

```
AADSTS700213: No matching federated identity record found for presented
assertion subject 'repo:lordvacuum5@329247604/police-chase@1370451181:ref:refs/heads/master'
```

The fix is a second credential carrying exactly that subject; the two sit side
by side and whichever form a run presents, one of them matches. The ids are in
the error, so the quickest way to get them is to let a run fail once:

```bash
az ad app federated-credential create --id <appId> --parameters '{"name":"github-master-immutable","issuer":"https://token.actions.githubusercontent.com","subject":"repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/master","audiences":["api://AzureADTokenExchange"]}'
```

Then three repository secrets (Settings → Secrets and variables → Actions):
`AZURE_CLIENT_ID` (the `appId`), `AZURE_TENANT_ID` and
`AZURE_SUBSCRIPTION_ID`.

Two things worth knowing, because both fail in ways that do not mention
themselves:

* **The subject has to match exactly.** The workflow names no `environment:`,
  because naming one changes the subject GitHub puts in the token from
  `…:ref:refs/heads/master` to `…:environment:NAME`, and sign-in then fails.
  Deploying from another branch needs its own federated credential.
* **The workflow asserts the app's settings** before it deploys — Oryx off
  (the build already happened on the runner), the startup command, and
  WebSockets on. They are settings rather than tiers, so this stays on the
  free plan; `Website Contributor` is enough to set them.

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake — and reverse once you have stopped |
| `A` / `D` | Steer |
| `Space` | Handbrake |
| `Shift` | Clutch kick (dumps the clutch to break the rear loose) |
| `C` | Cycle camera — chase / close / bonnet / cinematic |
| `R` | Flip the car upright, or restart after being busted |
| `P` | Pause · `H` Controls · `N` Sound on or off · `M` Back to the menu · `F3` Debug telemetry |

A gamepad works too: left stick steers, triggers are throttle and brake, `A`
handbrake, `X` clutch kick, **`Y` changes the view**. Held controls are sampled
with the driving; the face buttons that act like a key press are read once a
frame and go through the same path the keyboard and the on-screen buttons use,
so nothing downstream has to know where a tap came from.

`N` mutes, and now says so on screen. It always worked — the master gain goes
to zero and the radio stops — but the only confirmation was a line in the radio
log, and the log is hidden, so muting was a key press with no visible answer at
all: *"I have to turn the sound off on the keyboard, and it doesn't seem to
work."* A mute you cannot see is indistinguishable from one that did not
happen.

**The speedometer reads in mph**, and so does the radio: a unit calling in
"speeds 130" while the needle in front of you said 80 was nonsense, and the
roads are British ones. The dial runs to 180, past anything in the game.

**The plate by the dash is the road you are on** — the same names dispatch
has always used on the radio, so "last seen on Cold Harbour" and the sign in
front of you agree, and a call about a road you are nowhere near is easy to
tell from a call about yours. Cut across a field and it keeps the last road,
dimmed, rather than blanking every time two wheels touch grass. It sits above
the dial on a desktop and beside it on a phone, where what is above the dash is
the road you are trying to look at.

Sound only starts after your first key press — browsers refuse to play audio
until the page has been interacted with.

### On a phone or tablet

The touch controls appear on their own on a phone, or on any screen the moment
it is touched, and a key press on a machine with a mouse puts the desktop layout
back. Add `?touch` to the address to see them on a desktop.

| Touch | Action |
|---|---|
| Left half of the screen | Steer: put a thumb down anywhere and slide it left or right. Wherever it lands is the middle, so there is no stick to find without looking |
| `GAS` / `BRAKE` | Throttle and brake — slide between them without lifting, as you would rock a foot |
| `HANDBRAKE` | Handbrake, usable while holding either pedal |
| `II` `CAM` `FLIP` `SND` | Pause · camera · flip upright · sound on or off |
| `FULL` | Full screen, and landscape where the phone allows it to be locked. On an iPhone it says how instead — see below |
| `MENU` | Back to the menu — tap twice, so a stray thumb does not end the run |

Sideways is the way to hold it. Upright works, with the view widened so there is
still road either side of the car, and a note suggesting you turn the phone.
The HUD shrinks to fit round the thumbs, and after being busted a `RUN AGAIN`
button stands in for `R`.

**Full screen on an iPhone** is not something the page is allowed to ask for:
Safari has never given the Fullscreen API to anything but video, so
`document.fullscreenEnabled` is false on every iPhone. The button used to hide
itself when it saw that — *"on some phones, and mainly on Apple phones, you
can't see the full screen button"* — which was wrong twice over, because there
is a way to play it full screen there; it is just not one a button can press.
The button now stays and explains it: **Share → Add to Home Screen**, and
opened from there the game gets the whole screen, because the page carries the
`apple-mobile-web-app-capable` and status-bar meta tags that make an added page
open without Safari's bars. Launched that way there is nothing left to hide, so
the button takes itself away.

It is all in `src/core/touch.js`, and it does not drive anything itself: it
publishes throttle, brake, handbrake and steering for `Input.sample` to merge
with the keyboard, and its buttons press the same virtual keys the keyboard
does, so `_handleKeys` is still the one place that decides what a key does.
Two phone rules needed handling. A finger going *down* does not count as
interacting with the page — only lifting it does — so audio is also woken on
`pointerup`. And an iPhone will only let a page speak once it has spoken from
inside a tap, so the first tap speaks a silent empty line to unlock the radio.

**Playing it on a phone** needs the game served somewhere the phone can reach:
`serve.ps1` only listens on `localhost`. It is plain static files with relative
paths, so GitHub Pages serves it as it is.

---

## How the driving model works

Nothing about the handling is scripted. Each car is one Rapier rigid body with
four raycast wheels:

* **Suspension** — a spring/damper per corner, plus anti-roll bars. Body roll,
  dive and squat all fall out of this rather than being animated.
* **Tyres** — a *combined-slip* Pacejka model. Longitudinal and lateral slip are
  normalised by the slip at which each peaks, combined into one slip vector, and
  a single curve gives the force magnitude, acting against the direction of that
  vector. Grip is also load sensitive: a tyre carrying 6 kN gives less than twice
  the grip of one carrying 3 kN, which is what makes weight transfer cost the car
  net grip and lets understeer and lift-off oversteer emerge on their own.
* **Wheel dynamics** — each wheel has its own angular velocity, integrated
  semi-implicitly (the tyre is far too stiff against a wheel's inertia to
  integrate explicitly at 120 Hz). Lock a wheel under braking and it stays
  locked; there is no ABS.
* **Drivetrain** — torque curve, six close ratios, reflected driveline inertia,
  engine braking, and traction control that backs the engine off when the driven
  wheels spin (disabled by the handbrake and the clutch kick, so deliberate
  slides still work).
* **Steering** — available lock is sized by what the tyres can actually use at
  the current speed: the Ackermann angle for the target lateral acceleration,
  plus an allowance for front tyre slip. It never drops below the lock needed to
  point the front wheels along the direction of travel, so a slide is always
  catchable. The rack also takes real time to move, because slamming to full
  lock in three frames just scrubs the front tyres.
* **Surfaces** — road (μ 1.42), pavement and city blocks (μ 1.12), grass
  (μ 0.62). The footway also stands 140 mm above the carriageway, so clipping a
  kerb costs grip *and* unsettles the car — see **Kerbs**.

Measured behaviour of the player car (`runner`), on a flat asphalt pad:

| Test | Result |
|---|---|
| Static wheel loads | 14.55 kN vs 14.52 kN kerb weight, 52.5 % front |
| Steady-state skidpad | 0.98 g with all four wheels loaded |
| Braking from 100 km/h | 1.15 g, front wheels locked |
| 0–100 km/h | 7.3 s · 0–160 km/h 15.4 s · top speed 214 km/h |
| Handbrake turn | body slip to −37°, catchable on opposite lock |
| Full lock at 20 km/h, coasting | front tyres at 0.76 of the limit (no scrub) |
| Full lock at 20 km/h, full throttle | rear slip ratio 0.62 (was 2.18 uncontrolled) |

Rendering uses 4x multisampling. The world is flat-shaded faceted geometry, so
almost all of the aliasing is on polygon edges -- exactly what MSAA fixes, and
far cheaper than rendering at a higher pixel ratio, which is why the device
ratio stays capped at 1.

**Every police car runs this same code.** When an officer botches a PIT they spin
out for exactly the reasons you would.

### Rubber-banding

Units closing from a distance are helped, and the help is gone by the time they
reach you. A pursuing car gets up to **+50% speed** (scaled by how far behind it
is, reaching the full amount at 250 m), extra grip, and a stability assist that
keeps it from getting out of shape. All three taper away between 50 m and 30 m,
so the part of the chase you can actually see is fought on the same physics you
are driving on. Ambient patrols are never assisted.

A unit still on its way is also **shielded**: it records impacts for sound and
camera but takes no damage, so a crash en route costs it time rather than
putting it out of the chase. Shielding ends at the same 30 m boundary.

Tuned in `Officer._updateAssist` (`src/ai/officer.js`); the vehicle side is the
`assist` block in `src/physics/vehicle.js`.

### Driving within their means

Path following gets its speed from the curvature planner, but driving straight
at a target bypasses all of that -- which is how units ended up flat out into a
building the target happened to be behind. `Driver.safeSpeed` caps every
command by two things: the distance it could stop in, probed by raycast *toward
the aim point* (probing along the nose reads the building on the outside of
every corner as a wall and reduces the whole force to a crawl), and the grip
limit of the arc it is being asked to turn through.

### Better brakes than yours

Fleet cars stop considerably shorter than the runner does, and it is built from
three separate things rather than a single fudge factor.

**Anti-lock.** Without it, brake torque past the grip limit simply stops the
wheel, and a locked tyre slides at the sliding-friction fraction of peak — so
the last part of the pedal makes the stop *longer*. It is modelled as a closed
loop on slip ratio, integrating the error to trim brake torque toward the peak
of the curve.

Getting there took two wrong turns worth recording. A bang-bang version that
waits for lock-up and then backs off stops nothing — by the time last step's
slip ratio says the wheel is locked, it *is* locked. A fixed torque cap at the
tyre's peak is no better, because that cap sits *above* the force a locked tyre
still generates, so nothing can spin the wheel back up.

**A bug in the wheel integrator**, which is what was really holding the wheels
down. The semi-implicit wheel update linearises the tyre about its current slip
using `f.stiffness` — but that is the slope at the *origin* of the force curve,
and past the peak the curve is flat. Out at full lock it is completely flat, so
the origin slope invents an enormous damping term that holds a stopped wheel
stopped however little brake torque is left on it. Anti-lock could correctly cut
the torque to a third and still not get a wheel turning. The stiffness estimate
now falls off with slip, so it is the real local slope; low-slip behaviour, which
is what the semi-implicit step was added for, is untouched. Wheel lock-up
through a stop went from 96% to **7%**.

**Braking rubber.** Anti-lock alone only brings the heavier patrol car level
with the runner, because in this tyre model a locked tyre keeps 84% of peak and
locking costs almost nothing. `brakes.gripBonus` scales the longitudinal force
while the pedal is down and the force opposes motion — so it buys stopping
distance and nothing else. A police car corners and accelerates exactly as it
did.

From 100 km/h on dry road:

| | stop | mean | wheels locked | vs runner |
|---|---|---|---|---|
| Runner (you) | 33.3 m | 1.18 g | 95% | — |
| Patrol | 26.8 m | 1.47 g | 7% | **6.5 m shorter** |
| Interceptor | 25.7 m | 1.56 g | 7% | **7.6 m shorter** |
| Unmarked | 24.4 m | 1.61 g | 7% | **8.9 m shorter** |

The AI plans against only four fifths of the advantage. Planning on all of it
means arriving at every junction on the limit with nothing in hand, and the
measured cost was five times as much car-to-car contact — a unit stops in the
distance it promised itself, and the one behind does not.

It is not free. Cars that can brake later carry more speed, and on the town map
the median pursuit pace went from 44 to 54 km/h with scenery contact rising
from 0.29 to 0.39 per car-minute. That is the trade being bought: they commit
harder because they can.

### Braking for the junction, not for the target

A unit running alongside its target commits to a speed on the strength of a
clear line *to the target*. Then the target turns, and the unit arrives at the
junction far too fast to take it — and goes straight on into whatever is on the
far side. It cannot predict your moves, and should not: what it can do is never
be going faster than the road it is on can absorb.

Two things were missing. The clearance probe only ever looked toward the aim
point, which answers "is the way I want to go clear" — at speed a different
question from "is the way I am *going* clear", and the second one is the one
that ends with a car in a wall. And every check was collider-based, so open
ground was invisible: a bend with a field on the outside of it has nothing
solid anywhere near it, and the way ahead reads as completely clear right up
until the car is in the field.

So there are now two more caps on every speed command:

* a second clearance probe along the direction of travel, giving a plain
  stopping distance;
* **road runout** — how far the car can carry on along its current trajectory
  before it leaves the carriageway, walked over the surface raster rather than
  cast as a ray, because what is being looked for is the absence of road, not
  the presence of an obstacle. Arriving somewhere the road ends in thirty
  metres means being slow enough to *turn* within thirty metres, so the cap is
  the cornering limit for that radius.

The runout probe follows an **arc**, curving at whatever rate the car is
turning at right now, and that distinction is the whole value of it. Probed in
a straight line, a car correctly following a bend is forever about to leave the
road — on the town map the check fired 84% of the time and degenerated into a
flat speed limit. Along the arc, a car turning enough to make the bend sees
clear road ahead, and a car that is not sees the field it is about to arrive
in. That is exactly the difference between making a junction and going straight
on at it.

Measured over 90 s at four stars, same script both ways. Impacts are counted as
step changes in speed rather than as damage, because units more than 30 m from
the player are damage-shielded and a damage-based count quietly ignores most of
the map:

| per car-minute | Ashfield before | after | Wexbury before | after |
|---|---|---|---|---|
| hit scenery | 0.44 | **0.00** | 1.37 | **0.29** |
| hit another car | 0.51 | **0.12** | 0.26 | **0.23** |
| stopped dead | 0.06 | 0.12 | 0.85 | **0.35** |
| time on grass | 0.8% | **0.4%** | 18% | **11.6%** |
| median speed | 50.9 km/h | 49.3 | 39.9 km/h | **44.2** |

Ashfield pays about 1.6 km/h of median pace, and 7 km/h off the top end, for
never hitting the scenery at all. Wexbury gets it for free — it comes out
faster, because the time was not being spent driving.

### Knowing how much grip they have

Both of those planners used to assume dry tarmac — a hard-coded 1.42 — whatever
the car was actually standing on. Grass is 0.62, less than half, so a unit with
two wheels on a verge was planning corners against more than twice the grip it
had; and having started to slide it went on asking for exactly the speed that
caused the slide, so the slide continued to the next junction. Three things
changed:

* **Plan against the real surface.** `Vehicle.surfaceMu` averages the peak
  friction under the grounded wheels, and both planners use it.
* **Believe the evidence.** `gripEstimate` falls while the car is genuinely
  sliding and returns slowly once it has hooked up, so a driver who has just
  been caught out spends the next few seconds driving within itself. Floored
  well short of a crawl — the point is to stop chasing grip that is not there,
  not to turn everyone who steps out once into a learner.
* **Actually lift.** While sideways, the speed target is capped *below current
  speed*, scaled by how far gone the car is and by whether this driver can hold
  a slide at all.

### Damage

Hard to collect, ruinous to carry. Contact is the texture of a pursuit -- kerbs,
cones, the pack bumping each other, a scrape along a wall -- and the runner was
taking bodywork damage from all of it. The impact threshold is up from 1.4 to
2.6 m/s of sudden velocity change, the rate is down, and the runner's
`durability` went from 1.25 to 3.2:

| impact | damage before | after |
|---|---|---|
| 3 m/s (a kerb) | 7% | **1%** |
| 10 m/s (a solid hit) | 38% | **10%** |
| 24 m/s (a real crash) | 99% | **28%** |

The trade is that what does get through matters. Engine torque used to bottom
out at a third; it now falls to **a tenth** at full damage, and starts falling
sooner:

| damage | 0% | 25% | 50% | 75% | 100% |
|---|---|---|---|---|---|
| torque | 100% | 100% | 80% | 35% | **10%** |

A clean run is now genuinely clean, and a wrecked car is genuinely wrecked --
rather than every chase ending with a car that is vaguely down on power.

### Pressure scales with the wanted level

One star should be shakeable by driving quickly; five stars should be what it
already was. Two things scale, and both land on exactly the old value at the
top of the range so nothing about a five-star chase changes.

**How far they can see.** The old rule gave a single first-star patrol car
142 m of vision, which is most of a city block in every direction and far more
than one car that has just been told to look out for you should have:

| stars | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| before | 142 m | 164 m | 186 m | 208 m | 230 m |
| after | **102 m** | 134 m | 166 m | 198 m | 230 m |

**How hard they press.** `Officer.pace` caps the speed a unit will ask for as a
fraction of what its car can do, and the rubber-band catch-up boost scales the
same way -- giving a first-star patrol the same help as a five-star pursuit is
what let one car hang on to a flat-out runner it had no business staying with.

| stars | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| pace | 0.74 | 0.81 | 0.87 | 0.94 | 1.00 |
| max boost | 1.25 | 1.38 | 1.50 | 1.63 | **1.75** |

Measured peak speed over one fixed motorway route, so the road is not a
variable: 151 km/h at one star rising to 163 at five, against 124 for the
player's car on the same route.

### Seeing behind them

Perception used to apply a forward cone while in contact, blanking anything
more than about 124 degrees off the nose -- which made a car sitting *directly
behind* a police unit completely invisible to it. Dropping in behind them is
the most natural thing in the world to do in a chase, and it worked far too
well. The cone is gone: a crew has mirrors, a passenger and a radio, and the
thing that actually stops them seeing you is a building, which the line-of-sight
test already handles.

### Committing to a route

Watched from across the map, the pack used to look like it could not make up
its mind: *"they keep changing their minds, and they keep on going forward, so
they just end up crashing."* Three separate things were re-deciding faster than
a car can act on a decision.

* **The intercept was re-solved every second** and the junction that looks best
  moves with the target, so a unit was handed a different one most seconds of
  the chase. It now keeps the junction it has while that junction is still
  worth having, and gives it up only when it can no longer get there in time or
  the target is clearly not coming that way.
* **A route to a moving point was re-planned every 1.1 s**, and the goal is the
  nearest junction to the last place the target was seen — which shuffles along
  the road as they drive. A route is now kept unless the goal has genuinely
  moved somewhere else (35 m near, 70 m far), and the periodic re-plan slows to
  4.5 s once the goal is more than 150 m away. A car that far out has nothing
  to gain from re-solving the same road twice a second.
* **The direct-line corridor** flipped with every tree (see "A tree is not a
  wall").

### Roadblocks need to know where you are

They were going in while the force was *searching*. Siting a block needs a
direction of travel to put it ahead of, and a force that has lost you has no
business setting up in front of a car it cannot see. Placement now requires
contact.

The check is deliberately split from the one governing teardown: `allowed` is
just the heat tier, `canPlace` adds contact. Gating both on contact would
dissolve a block already standing the moment you broke line of sight for a
second.

### Air support

At five stars a helicopter comes up. It changes the shape of the chase rather
than adding another car to it: no route to follow, nothing to shake off in a
corner, and -- the point -- it sees over the rooftops. It is a spotter like any
other unit but exempt from the line-of-sight test, so ducking behind a building
stops working while it is overhead. What still works is distance: it has a
190 m radius like everything else, drawn on the minimap as its own ring.

It is deliberately not a physics body. It flies above the world, touches
nothing, and exists to feed the dispatcher a spotter. Flight is steer-and-
accelerate rather than a position lerp -- it has momentum, overshoots, and
swings back, which is most of what makes it read as flying rather than sliding
along a rail. It banks into its turns, noses down with speed, and puts a
searchlight on you once it is actually overhead.

Measured: silent below five stars; launches from about 420 m out and closes to
106 m within seventeen seconds; and with **every police car removed from the
map** it alone keeps the dispatcher in contact. Drop below five stars and it
goes home.

**Faster than any car — actually.** Its top speed was 62 m/s, 223 km/h, which
was faster than any car until the Stiletto turned up at 303. `tests/outrun.js`
flies it on its own over a car driven along a fixed course, starting on station
overhead, so nothing else in the chase helps or hinders it:

| car on a long straight at | 62 m/s: light on the car | 78 m/s: light on the car |
|---|---|---|
| 200 km/h | 100% | 100% |
| 230 km/h | 72%, then lost for good | **100%** |
| 257 km/h (the Stiletto flat out) | 19%, then lost for good | **100%** |
| 280 km/h | — | **100%** |
| 300 km/h | 13%, 2.4 km behind at the end | 32% |

Once the light slipped off a car going faster than the aircraft, it never came
back: the light hunts around where the car was last seen, and the car was
already well past that. On a course of city blocks — flat out down a 400 m
straight, braking for a right angle at 70 km/h — it held the car the whole two
minutes at either speed, because every corner lets it cut across. It is now
78 m/s, about 280 km/h, which is roughly what a light twin does flat out and is
clear of the fastest car in the game.

**Losing it means losing it.** Once the force has lost you, the aircraft flies
where its own searchlight is hunting — round the last place anybody saw you,
widening the circle the longer it has been — rather than on over your car
wherever you went, which gave the game away: *"the spotlight looks around, but
the helicopter still stays with me."* It follows the car only while somebody
actually has it: the light on it, a ground unit with eyes on, or the three
seconds of tracking after sight is lost. Measured with `tests/outrun.js`, it
still holds a car at every speed any car can reach; a car that did get away was
6.6 km from it two minutes later, where before it was followed the whole way.

**The searchlight lights the ground.** The pool used to be only a bright disc
laid just above the road, and footways stand a kerb higher than that, so
wherever the beam fell on a pavement the pavement covered it: *"the police
helicopter is not lighting up the pavements."* It is now a real spot light as
well, from the aircraft to wherever the beam is
pointing, sized to the beam, so kerbs, pavements, walls and cars inside it are
all lit by it, at night and in the rain most obviously. It exists from the
start at zero brightness rather than being added when the aircraft arrives:
adding a light to the scene makes every material rebuild its shaders, a visible
hitch in the middle of a chase.

### The detection ring

A red ring on the minimap, always centred on your own marker, showing how far
the force can see you right now. It grows with the wanted level:

| stars | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| radius | 142 m | 164 m | 186 m | 208 m | 230 m |

It is a *range limit, not a guarantee*. Line of sight still has to be clear, so
a unit inside the ring with a building between you cannot see you -- but a unit
outside it cannot see you whatever the geometry. That asymmetry is the whole
value of drawing it: every car outside the ring is one you do not have to think
about.

The ring vanishes the moment they lose contact, because the rule it draws is no
longer the one in force -- searching units use a much shorter reacquire range
and no forward cone. The last-known marker takes over instead.

The radius is published by the dispatcher from the same variable the perception
test uses, rather than recomputed for the HUD, so the circle cannot drift away
from the rule it is claiming to show.

### Tracking, and the three seconds after you break sight

Losing line of sight does not lose you instantly. For **three seconds** the
force keeps a hard fix on exactly where you are — radio, other units, a fair
guess at where that road goes. A bar appears the moment they lose sight and
drains over those three seconds, turning from orange to blue for the last
third; regaining sight clears it and resets the clock.

Ducking behind one building is not an escape. Staying out of sight is. Only
once the bar empties do they fall back to your last known position, and only
after that does it become the sixty-second search.

**The whole bar, not half of it.** The window is one number and everything now
reads from it. It used to be two: the bar ran for three seconds while the force
downgraded itself to a reacquire at 1.5 — so halfway through, the detection
ring shrank from 198 m to 68, the screen announced a search, and the minimap
put up a "last known" marker for a car it could see perfectly well. *"It shows
that they're searching, but they still need to be in full pursuit of me... not
searching until that timer runs out."* Now, for the full three seconds: the
ring stays, the status line still says PURSUED, and no last-known marker
appears. The moment the bar empties, all three change together.

### Searching off the road

*"Make sure the police search off-road."* They did not. A search was a wander
between road junctions round the last place you were seen, and a car that has
stopped is only picked out from about sixty metres at three stars — so parking
in a field, a car park or behind an estate a little way from the road was
close to a guaranteed escape.

Now each searching unit picks a spot to check and drives to it (`Officer._search`):

* **Where.** Three spots in four are off the road, the further from any road
  the better, since nobody has looked there; the fourth is a stretch of road,
  which is still the quickest way to see a car tucked just off one. Spots are
  spread so two units do not check the same place, lean the way you were
  heading when contact went, and move further out the longer you have been
  gone.
* **Only somewhere with a way in.** An off-road spot is only taken if there is
  a straight, clear lane to it from a road, swept the width of the car. On
  Wexbury — houses with back gardens — reaching spots any other way meant
  scraping along the side of a house on the way in and again on the way out.
* **Getting there.** Along the roads at a searching pace (80 km/h at most, on
  a route planned round the bends, that runs along the stretch of road the
  lane leaves from), slowing for the turn off, then down the lane at 36 km/h.
  On the road a searching unit keeps to the carriageway like a patrol car: it
  leaves the road on purpose or not at all, because cutting corners between
  spots was most of what it hit.
* **Looking.** Close to the spot, a clear view of it counts: a unit that cannot
  get any closer does not sit nosing at the fence. One that stops getting
  closer at all gives up, remembers the place and goes somewhere else.
* **Leaving.** Out the way it came in — it keeps the line it drove — rather
  than straight for the nearest road, which on Wexbury is very often through
  a house.

`tests/search.js` parks the car off the road, tells the force it lost contact
at the nearest bit of road, switches spotting off so the search runs the whole
minute, and records where the searching units go. Three stars, five units:

| | hidden | | time off the road | found within the minute | impacts |
|---|---|---|---|---|---|
| Ashfield City, 8 places each | 30–60 m from a road | before | 5% | 8 of 8 | 4 |
| | | now | **27%** | 8 of 8 | **1** |
| | 60–70 m from a road | before | 2% | **1 of 8** | 4 |
| | | now | **21%** | **7 of 8** | **2** |
| Wexbury, 12 places each | 30–60 m from a road | before | 6% | 9 of 12 | 5 |
| | | now | **29%** | 8 of 12 | **2** |
| | 60–140 m from a road | before | 4% | **2 of 12** | 5 |
| | | now | **25%** | **8 of 12** | 5 |

"Found" is a unit inside the stopped-car sight range with a clear line to you.
Close to a road the old search did about as well — sixty metres of sight covers
both sides of the road it is driving — but anything further in was effectively
never looked at, and now is. The impacts are mostly bumps at walking pace; the
first version of this, which let units reach spots however they could and use
the ordinary road router between them, had nine and eight on Wexbury, some at
up to 90 km/h.

### A tree is not a wall

Seeing and driving are different questions, and one mask was answering both. A
unit decides whether to drive straight at the target by sweeping a corridor the
width of its own car toward them; that corridor was tested against buildings
*and props*, and a tree is a prop. So in woodland the line was "blocked" by a
trunk sixty metres away, and the unit went the long way round by road — *"they
seem too scared about hitting trees, they don't go in small gaps between
trees"* — while a trunk drifting across the corridor flipped the answer several
times a second and the unit changed its mind with it.

The corridor now tests walls only (`RAY_WALL`). Trees are still solid, still
hurt, and are still steered around by the sweeps that do that job; they are no
longer a reason to take the roads. The answer also has hysteresis: blocked is
believed at once, but a corridor that was blocked has to read clear for half a
second before the unit commits to the straight line again.

**And there are fewer of them.** Measured as tree colliders on each map:
Wexbury 1942 → **1193**, Ashfield 1321 → **918**. Copses are thinner, hedgerow
trees are spaced further apart and skipped more often. An English market town
surrounded by woodland is right; one whose outskirts are a forest is not, and
every trunk is a collider the broad phase pays for — the town's total collider
count came down from 3230 to 2481 with it.

### The sweep that was only right facing north

*"It was trying to turn into a gap between two buildings, but it thought it
couldn't make it, so it stopped — and it had loads of room. And they'd still
crash into trees at that high speed. It's like they have a bubble around all
these objects that is too big."*

Both halves of that were one line. Every obstacle check — will this fit, how
far to the thing in front, which side has more room — sweeps a box along the
direction of travel, and the box was created at the world's own rotation and
never turned. Its half-extents are (car half-width, 0.5, 0.25), so heading
north or south it was a car-width plate, which is right; heading east or west
it was that plate turned sideways: 0.5 m wide and 4.3 m deep.

Measured from twenty metres back, the same wall and the same 1.6 m hole in it
(`tests/bubble.js`; 18.75 m is the correct answer, the wall's own half-depth
and the plate's taken off):

| | wall | 1.6 m gap, which a 1.94 m car does not fit through |
|---|---|---|
| north / south, before | 18.65 m | 18.65 m |
| **east / west, before** | **17.95 m** | **clear for 60 m** |
| every heading, now | 18.75 m | 18.75 m |

So driving east, a unit believed a wall was 0.8 m closer than it was — the
bubble — and believed it could thread a gap two thirds of its own width, which
is how a car at speed ends up wearing a tree. Which of the two you got depended
on which way the car happened to be pointing, which is why it looked arbitrary.
The plate is now turned to face the way it is being swept, and all four
headings agree to the centimetre. `tests/gaps.js` is unchanged by it: still
through a 2.2 m gap, still nothing touched.

### Going up on two wheels

*"If you go on a kerb and turn really hard, it starts to tip over."*

Cornering force entered the body at the contact patch, which puts the whole
half-metre from tarmac to centre of mass under the car as a lever to roll it
on. The Stiletto was given a roll centre of 0.18 m when it turned out to have
the grip to turn that lever over; the saloons had the same lever, just less
grip to pull it with -- and a kerb makes up the difference.

Measured climbing a real kerb at full lock (`tests/tipping.js`), at 95 km/h:

| | roll before | roll now | wheel in the air, before | now |
|---|---|---|---|---|
| Runner | 8.7° | **6.1°** | 0.45 s | **0.20 s** |
| patrol | 8.3° | **4.5°** | 0.27 s | **0 s** |
| interceptor | 7.9° | **4.7°** | 0.38 s | **0.15 s** |

**The tyres pay for it.** A car on four wheels corners harder than one on
three, so the roll centre alone handed the Runner 1.40 g → 1.52 and the
drivable interceptor 1.52 → 1.72 -- which put a police saloon above the
Stiletto, the escapee's one real advantage, for a change nobody asked for. So
`gripScale` gives back what the geometry gained (`ROLL_PAYBACK`), and measured
after both: Runner 1.41 g, 0–60 in 7.0 s, 134 mph; interceptor 1.55 g, 5.8 s,
152 mph. Within a hundredth or two of where they were. What changed is the
tipping, and nothing else.

One thing did come free: the Runner used to lose it completely at 170 km/h on
full lock -- `tests/supercar.js` recorded 0 g there, meaning it spun rather
than cornered. Standing it up gives 1.47 g instead.

### Following their trail, tried and not kept

The pursuit's own geometry is what holds a unit back, and it is worth writing
down what that means before the next person tries to fix it.

A unit aims at the car it is chasing. `safeSpeed` then limits it to what the
arc to that aim point allows, because for a car an aim point off to one side
*is* a corner. Measured over a 120 km/h pursuit, the angle between a unit's
nose and its aim point ran 23° at the median, 40° at the third quartile and
68° at the ninetieth — and at a 41 m aim distance, 40° is a 32 m turn, which on
tarmac is 74 km/h. That is the whole answer to "why are they so slow": not the
engine (an interceptor tops out at 241 km/h against the Stiletto's 240), not
the signs (`planSpeed` is called zero times in a direct pursuit), and not the
grip. They are cornering, constantly, because they are pointed across the road
at a car that has already gone round the bend.

So the obvious fix is to follow the line the suspect actually drove instead of
the car itself: it is on the road, it bends the way the road bends, and a unit
following it is already pointed along it. Control kept a trail — a point every
eight metres, the last sixty of them — and a pursuing unit steered at the point
on it a lookahead ahead of wherever it had got to.

It measures worse, and it keeps measuring worse after the obvious bug in it was
fixed. Against a 120 km/h target: mean speed 49 km/h down to 39, the speed the
limiter allowed 83 down to 69, and the aim angle it was supposed to shrink went
the wrong way — 29° to 36° at the median, 114° to 129° at the ninetieth. A car
that has cut a corner is nearest to a piece of trail it has already passed, and
chasing a fixed breadcrumb eight metres from the next one swings the angle
about more than aiming at the car ever did.

### A standoff point behind them, tried and not kept

The other obvious shape of the same idea, and the better one: rather than
follow a trail of fixed breadcrumbs, aim at a point a share of the gap *behind*
the suspect along the way they are actually travelling. It has none of the
trail's problems — the point moves continuously with the car it is derived
from, so there is nothing to overshoot — and a car forty metres beyond a corner
and well off to one side becomes a point near the corner itself, more or less
straight ahead.

It does what it says to the geometry. The median aim angle came down from 31°
to 27°, the speed the limiter allowed went from 74 to 88 km/h, and it needed
one guard to be worth anything at all: a unit that has cut inside is already
past the point it would be hanging back to, and aiming behind itself is worse
than anything it was doing before.

And over four routes it is worth nothing. 59 km/h against 57, within 60 m of
the target 34% of the time either way, 119 m behind against 144. The single run
that sold it — 199 m behind becoming 96 — was noise, which is the lesson of
this whole section rather than a footnote to it: **one run of this rig is not a
measurement.** The route is deterministic, so repeating it answers identically;
the only way to sample is to run different routes, and `tests/keepup.js` now
averages four. Several of the numbers quoted earlier in this section were taken
one run at a time and should be read with that in mind.

The one real effect was on contacts, 27 down to 19, bought with 25 m of extra
distance — the wrong trade for a complaint about them being too far away.

### One thing at a time

The PIT, the rolling block and the van each had their own cooldown and nothing
held them apart, so a block could go in and the van arrive two seconds behind
it: *"the police car would appear and try to ram me, and then literally two
seconds afterwards the van will also appear and try to ram me."* Each of those
is meant to be a thing that happens to you; three at once is noise. They share
a nine-second gap now, set only when a car is actually produced — a tactic that
finds nowhere to deploy does not spend it.

The rolling block also went in from a flat 90 m whatever the speed, which at
180 km/h is under two seconds and is why those were the ones appearing on top
of you while the van, which has always insisted on 190 m, read fine. It is
seconds of closing now, and never nearer than the old figure: measured, the
nearest it will go in is 75 m at 50 km/h, 104 at 120 and 159 at 180.

### On the road you are actually on

A cone in front of the car is not the same thing as the road in front of the
car. Spawn points were picked from anywhere inside the band and the cone, so a
unit arrived on the street one block over, or out in a field — "just because I
was kind of facing that direction a minute ago" — and then there was a building
between it and the chase, which it drove into.

So a spawn in front now comes off a walk up the carriageway instead: from
wherever the player is, following the road forward and taking the straightest
way on at each junction, which is what somebody driving takes unless they
decide otherwise. It carries through an intersection rather than turning off at
the first one, and stops when the only ways on are real turns. Nothing else is
allowed in front at all; behind and beside still come from anywhere in the
band, because those are not being driven at.

A car on your own road beyond a bend also needs less of the warning margin than
one off to the side: the margin buys time to see something coming, and this one
is seen the moment you round the bend, at whatever distance that leaves. It
cannot be in front of you one frame and beside you the next, which is what the
margin is for.

Measured over 120 spawns on a driven lap: 4% land in front, **all of them on a
road and all of them over 200 m away**, and nothing fails to find a spot. On a
dead straight road nothing spawns in front at all, which is correct — there is
nowhere up there that is not in plain sight.

### Far enough away, in seconds

A car spawns at least 210 m from you and never where you are looking. Out of
view is not the same as out of the way: 210 m at a crawl is half the map, and
at 200 km/h it is under four seconds — less, if the spawn is in front of you,
because then you are driving at it. "They pop into existence with no time to
react" is a car that was never hidden for long, only hidden until you arrived
at it.

So the floor is seconds now rather than metres, turned into distance by how
fast the player is actually going, and it grows faster for a spawn ahead of
them than one behind, because only one of those is being driven at. The ceiling
moves with it or there would be no band left to spawn in at speed. Measured at
200 km/h, the nearest spawn ahead of you goes from 210 m to 747 m, and the
worst case anywhere from 3.8 seconds of warning to 7.4 — with no spawn
failures, which is the thing that would show up as a chase quietly thinning
out.

### The ceiling, measured: the limiter is not what holds them back

Before building a planner, it is worth knowing what one could possibly buy. A
planner's whole job here would be to let a unit carry more speed — so take the
speed limiter off altogether and measure that. Whatever it gives is the
ceiling; no amount of planning can beat simply being allowed to go as fast as
you like.

Over four routes against a 120 km/h target, `safeSpeed` returning infinity:

| | mean | with it | behind | contacts |
|---|---|---|---|---|
| as it is | 59 km/h | 36% | 118 m | 33 |
| no limiter at all | 56 km/h | 31% | **209 m** | 18 |

**The ceiling is below the floor.** Unlimited, they are slower on average and
end up nearly twice as far behind. Fewer contacts, too — because they are not
clipping things in town, they are out in the fields: without the cap they
arrive at every corner far too fast, understeer wide, leave the road and spend
the chase getting back onto it. The time lost to that is greater than the time
the cap ever cost them.

So the limiter is not a restriction on these cars, it is what keeps them on the
road, and the long chain of reasoning above — aim angle sets the arc, the arc
sets the speed, therefore fix the aim angle — is true in every link and leads
nowhere, because the speed it is protecting is speed they cannot use. That is
also why all six fixes failed, and it is worth more than any of them: the
remaining problem is car control, not planning. A unit that could place a car
through a bend at the limit would not need permission to go faster; it would
simply be faster. That is a much harder thing to build than a planner, and
nothing here says how much it would be worth.

### Driving the candidates before choosing one

*"I saw a police car avoid a tree and then hit headlong into another tree."*

That is the signature of a reactive avoider, and everything in here was one.
The wall bias, the avoidance bias, the gap search, the speed clamps — all of
them answer *what should I do this instant*, from whatever is nearest. Having
steered away from the first trunk the car is committed to a line with the
second one in it, and nothing ever looked. `planThrough` was a step up and
still not enough: its legs are straight lines from where the car is standing,
so it never asks whether the car could actually turn onto one.

`Driver.planTrajectory` drives the candidates instead. Eleven steering
fractions, each run forward on a bicycle model for up to three seconds — real
wheelbase, real available lock, so a line the car cannot take is never offered
— with the body swept along the result. The winner is the one that survives
longest, stays on tarmac and ends up nearest the goal. Sixty-six shape casts
per plan, four times a second per unit, and about 0.6 ms a frame with fifteen
cars on the board.

Three things fall out of the one mechanism. A path between two trees is found
because the whole path is tested rather than the first gap in it. The footway
stops being free, because surface is a cost along the way rather than a
yes-or-no about where the wheels are now — a direct push off the kerb was tried
first and made it *worse*, 20% of the chase on paving becoming 23%. And a
corner is entered at a speed the chosen line can hold, because the line is
known before the speed is picked rather than after.

In the copse, with and without, same session:

| | contacts | mean | left behind |
|---|---|---|---|
| without | 5 | 42 km/h | 383 m |
| **with** | **4** | **49 km/h** | **322 m** |

Fewer contacts, faster and closer — the first change in this whole section to
move all three the same way. An ordinary chase after a weaving target at 130
km/h is slightly better too: 57 km/h against 54, 196 m behind against 203,
worst damage 0.63 against 0.80.

It was worse than useless on the first measurement — seven contacts against
five — and the reason is worth keeping. The aim point was interpolated from the
car toward the plan's far end, which is a chord *across* the arc: the car was
steered at a line the plan never proposed, cutting the corner of the very thing
the plan had gone round. Aiming at a point actually on the path turned it from
a loss into a win without touching anything else.

### Why they cannot follow you between the buildings

*"I can just go through loads and loads of tight gaps really fast through loads
of buildings and then they just literally cannot do anything. They lose you
instantly, even on wanted level five."*

True, and `tests/weave.js` was built to find out why. Every other rig in here
chases along roads; this one sends a ghost weaving through the gaps of a
built-up area and asks how long the pursuit stays with it. On Wexbury, six
routes, a ghost at 110 km/h: at least one unit within 80 m for **30%** of the
run, the last one dropping past 150 m and staying there after **6.3 seconds**,
finishing 155 m back.

Getting the rig honest took two goes and both mistakes are worth recording. The
first version drew a straight line across the town and scored it on how many
buildings it passed *close to* — and every line it picked went clean through one
to three of them. A line that clips a building is not a weave, it is a teleport:
the ghost goes through the wall and no car on earth follows it, so the pursuit
lost the target at seven seconds whatever the driving did, and the rig could not
have told a good change from a bad one. Demanding a *clear* straight line then
found nothing at all, which is the answer to why: there is no such line across a
town, and the player is not driving one either. So the ghost weaves — eight
metres at a time, taking the heading nearest its bearing that is actually clear,
preferring steps that still have a building beside them so it threads the gaps
instead of strolling out into a field.

What the rig then showed is that they are not crashing and not stuck. One route
came back with no contacts, nothing reversing, nothing jammed — a clean drive at
76 km/h that still lost a ghost doing 110. They are simply slower, and
`Driver.caps` says exactly what makes them slower: each speed limit now records
itself every frame, and the rigs print the tally. The binding one is the
pure-pursuit cornering arc, **23% to 53% of all frames**, far ahead of the wall
clamp at 11–29%. Pure pursuit follows a circle of radius `Ld / (2 sin alpha)`,
and threading a gap means a large angle at short range, so that radius comes out
tiny and the grip limit collapses.

That instrumentation is the thing to keep. An afternoon went on the wall clamp
first, on the strength of a plausible story about it — units braking for
buildings they were going to steer round anyway. Making that clamp follow the
arc the car is actually turning on, rather than the straight line it happens to
point down, is a sound idea and measured as a wash. It was not the limit in
force. Guessing which clamp is binding does not work; the tally does.

Three ways of relaxing that cornering limit were then measured and none kept:

| | gaps: held on | gaps: hits | road at 150: behind | road: hits |
|---|---|---|---|---|
| as committed | 8.3 s | 10 | 215 m | 5 |
| plan's own radius | 9.4 s | 9 | 341 m | 16 |
| grip-limited plan fan | 10.2 s | 11 | — | — |
| longer lookahead | 6.4 s | 10 | — | — |

The first takes the radius from the plan, which chose its own steering angle and
so knows the curve the car will genuinely drive. In the gaps that is worth a
second of hanging on; on the road it is a disaster, because a plan knows about
colliders and nothing else, so a bend in open country reads as straight, its
radius is enormous, and the units stop slowing for corners at all. One wrote
itself off completely — damage 1.00 on a rig where nothing else has ever
exceeded 0.46. Confining it to close scenery fixed almost none of that, because
in a town there is a building seven metres from the kerb of every road. Gating
it on the plan being an actual S-bend, and bounding the lift, each recovered
part of it and not enough.

The second narrows the planner's fan to the steering the tyres can deliver at
the planning speed, so no line is planned that the car would have to slide to
take. One route was transformed — from losing the ghost at five seconds and 234
m back to never losing it at all — and the tightest route collapsed from 50 km/h
to 21, because at speed nothing grip-feasible fitted through the gap and the
planner had nothing to offer. Falling back to the full rack when the narrow fan
came back blocked recovered almost none of that either.

The third is the textbook remedy and the cheapest: look further along the plan,
so the aim point is less far off to one side, the angle falls and the radius
grows without anything being taken away. It moves speed and it moves contacts —
and it does not move how long they hang on at all, 6.3 s against 6.4 s against
6.3 s across the whole sweep. `planLook` and `planLookMax` are left settable for
the next person to try.

So the finding is not a fix. They do about 50 km/h through gaps a player takes
at 110, and every attempt so far to lift that has bought speed with crashes:
plus two contacts, plus eleven and a write-off, plus three. The limits are tuned
not to crash and the player is not. The thing that is probably wanted here is
not better following at all — a real pursuit does not thread the same gaps as
the car it is chasing, it uses the roads and converges on the far side — and that
belongs to the dispatcher and the roles, not to `safeSpeed`.

### Grip stretches with the band, not just power

The section above ends by saying that nothing tried had closed the gap, and that
the limit in force is the cornering one. This is the thing that moved it.

The rubber band hands a unit a long way back more power and 35% more grip. The
power is close to useless, which the band's own note admits: what holds a unit
back is cornering and no amount of engine helps with that. The grip is the part
that could, and it was not stretching with the band at all -- a car 300 m behind
got exactly the same 35% as one at 60 m.

Grip is the right lever for three reasons. `cornerSpeedLimit` goes as the square
root of it, so this is about 20% more speed through a corner. `Driver._mu()`
reads `assist.grip`, so the unit *knows* it has more and takes the corner faster
-- without that it would simply have more in hand and drive the same, which is a
mistake already recorded one section up. And the tyres get the same multiplier,
so the speed it takes is a speed it can actually hold. That last point is the
whole difference between this and the three ways of relaxing the limit directly,
every one of which bought speed with crashes.

It is distance-scaled like the rest of the band and gone by 30 m, so it is the
car three hundred metres back that gets it and the one on your bumper that does
not. The part of the chase you can see is still fought on the same physics you
are.

Weaving through a housing estate behind a ghost at 110 km/h, six routes:

| | held on | left behind | contacts | mean speed |
|---|---|---|---|---|
| without | 6.4 s | 186 m | 11 | 53 km/h |
| **with** | **7.9 s** | **152 m** | 12 | **60 km/h** |

And on the roads, four routes each, which is where it had to not break anything:

| | mean | with it | behind | contacts | worst damage |
|---|---|---|---|---|---|
| 90 km/h ghost, without | 66 | 54% | 103 m | 22 | 0.46 |
| **90 km/h ghost, with** | **70** | **61%** | **75 m** | **13** | **0.25** |
| 150 km/h ghost, without | 59 | 30% | 218 m | 20 | 0.44 |
| **150 km/h ghost, with** | **66** | 29% | **165 m** | 19 | 1.00 |

At 90 km/h it improves every column at once, which nothing else in this file has
done -- and it halves the contacts rather than paying in them, because a car that
can hold the corner does not need to hit the outside of it. At 150 it is 53 m
closer and 7 km/h faster for the same number of contacts, but one unit in eight
wrote itself off where the worst before was 0.44. That is the declared cost: at
motorway speed a car with more grip occasionally carries a corner it should not
have, and the unit is lost rather than merely delayed.

How much is a real question and the gaps rig alone answers it wrong. 0.70 is
clearly better there -- 132 m instead of 152 -- and ruinous on a road, where
the contacts go from 13 to 35. 1.12 is worse everywhere. 0.35 is the only value
that improves both, so that is the number.

### Why the extra grip made them slide out, and squeezing through gaps

*"The police cars seem to slide out more now and lose control... they also don't
seem to know that they can fit through tiny gaps, even if they hit the sides.
I'll shoot between two buildings but I'll slide slightly, so I end up hitting the
side of the building and bouncing off and keep going... they need to be less
scared almost of crashing."*

Both true, and the first was the section above's fault. Measured on the roads at
150 km/h, four routes, with the metric that was missing -- a unit can spin,
gather it up and carry on without touching anything, and that is still the thing
being complained about:

| | mean | behind | contacts | worst damage | sliding | lost the back end |
|---|---|---|---|---|---|---|
| before the grip change | 61 | 188 m | 13 | 0.51 | 5% | 2x |
| with it | 62 | 201 m | 15 | 1.00 | 8% | **7x** |
| **fixed** | **64** | **156 m** | 15 | 0.76 | **4%** | **3x** |

Three things were wrong and one of them is written in this codebase already.

**The bonus went to both axles equally.** Three lines into the high-speed grip
code in vehicle.js: *"Per axle, where a car needs it. Stiffening the fronts as
much as the rears on a car with 58% of its weight at the back makes the nose bite
harder than the tail can follow, and it spins."* A uniform multiplier is a front
multiplier in everything but name. The same average help pushed rearward --
`_assistGrip`, 0.65 front against 1.35 rear -- turns the extra grip into
understeer instead of oversteer and halves the sliding.

**It arrived and left instantly.** A unit closing from 50 m to 30 m lost all its
extra grip and all its stability assist inside a second, and if it was in a
corner at the time the floor went out from under it. The band's own note had
sized the old fade to avoid exactly that; stretching grip with distance made the
drop twice as big and brought it back. Both now ease with a time constant, over a
38 m fade rather than 20, and the stability assist stretches with the band too --
the thing being asked of a distant unit is to corner harder than it would dare,
and the assist is what stops that ending sideways. (More of it is not better:
four times the stability took the spins *up*, 5 to 10, because the corrective
torque starts fighting the driver.)

**The driver believed all of it.** `Driver._mu()` reads `assist.grip`, which is
what makes a unit actually use the grip rather than have more in hand -- but it is
a point mass with one number, and the car is rear-heavy and at its limit. The gap
between those two models is where the back end goes. The tyres now get the whole
bonus and the driver counts on 60% of it, so the difference is margin: the car can
hold more than the driver is asking of it, and gathers itself up instead of
spinning. Sliding that fraction with speed -- all of it in a slow tight gap where
the point mass is nearly right, less at road speed where it is not -- is the
obvious refinement and measured worse, putting the write-offs straight back.

### A map of the gaps, and learning to drive them

*"Why can't the police keep up? They are literally computers. They have perfect
accuracy. They know everything that's going on. I can chase my friend better than
they can chase me."*

The answer to the first part was not computation. The entire map the AI could plan
over was the road network -- streets, avenues, lanes, motorways, and nothing else.
The gap between two houses was not an edge in that graph, so it did not exist:
cutting through an estate made the pursuit stop navigating and start groping,
sweeping a fan of headings and taking the clearest arc three seconds at a time. It
is also why heading the car off failed, since `RoadGraph.predict` walks roads and
the junctions units were sent to were on roads the car was not using. A human
chasing a friend through the same estate does not follow their line at all; they
know the alley comes out on the next street, so they take the street. That is a
map, not a reflex.

`world/cutgraph.js` builds the part that was missing. A clearance field first: how
far the nearest solid thing is from every two-metre cell, taken from the physics
colliders rather than from the generator, so it knows what actually got built and
works on any map. Then A* across that field between pairs of road nodes, kept only
where going round by road is at least half again as far, measured at its tightest
point with a pair of rays, filtered to things that are genuinely gaps between
buildings rather than open ground, and finally verified by sweeping a car-shaped
box along the whole polyline end to end. On Wexbury that leaves 14 of them, each
saving between 30 and 480 m: 636 m round by street against 155 m through a
fifteen-metre gap. They go in as ordinary graph edges, so the router,
`pathFromPosition`, `routeTime` and the predictor all get them for nothing, flagged
`cut` and kept out of the spatial index so that nothing which asks "which road is
this" can ever be answered with an alley. The grid city yields none, which is
correct rather than a failure: a regular grid has no shortcuts worth taking,
because the roads already go everywhere directly.

All of it is switched off at `CUTS_ON`, for a reason two sections below.

**And on its own it was worth nothing.** Three of four sessions came back worse
with the gaps than without, and one number said why: a unit routed through a gap
spent about a third of its time in there under 4 m/s. The shortcut was shorter and
it was not quicker. The router costs edges by time, so it kept choosing one, and a
unit crawling down an alley is further from the car than one going round at speed.

### Why they crawled, and what each thing cost

`tests/gap.js` drives one car through one gap -- no target, no dispatcher, no
roster -- and reads which of `Driver.caps` was the binding limit while it was in
there. Three separate things were holding it back, and the tally found each in
turn rather than anyone guessing:

| mean through | the binding limit | what it actually was |
|---|---|---|
| 28 km/h | its own asked speed, 58% | the edge's posted 8 m/s, set to discourage the *router* and obeyed by the *driver* too |
| 38 km/h | the aim probe, 58% | "be able to stop in what you can see", aimed at the wall at the far end of the corridor |
| 37 km/h | the route itself, 44% | the route was never verified at its ends, so the first hop out of the junction clipped a corner |
| **55 km/h** | its own asked speed, 85% | nothing left in the way |

The first was a plain bug of mine: one number doing two jobs. `pathToPoints` copies
an edge's speed onto every point of a path and the driver obeys it, so the 8 m/s
meant to make the router reluctant was also telling the car to crawl. `cutSpeed`
now gives a gap a posted speed from its width, and `CUT_PENALTY` carries the
reluctance by itself -- four seconds, and the first attempt at fourteen overshot so
far that half the gaps were never driven at all.

The second is the more interesting one. Both of `safeSpeed`'s probes are straight
lines, and a corridor that turns at the end has a wall at the end of *any* straight
line -- so whichever is asked reports a short distance and the car brakes for a
building it is about to steer round. Swapping one probe for the other moved the
binding limit and nothing else, 38 km/h to 39. `Driver._pathClear` asks the right
question instead: sweep the car's own footprint along the path it is actually going
to drive, segment by segment, and report where that first touches something. On a
straight road it gives the same answer as before; through a gap it gives the honest
one. The travel probe stays as it was, because that is the one that catches a car
which has run wide and is leaving its route -- taking it out as well bought two
km/h and cost four contacts in fourteen gaps and real damage on the roads.

The third was mine again: the A* works in two-metre cells and its path starts at
the cell containing the road node rather than at the node, so the hop from the
junction into the mouth of the gap was unchecked. Harmless while the driver was
cautious; a unit driving into a wall once it started trusting its route.

With all three, 13 of 14 gaps are driven through at a mean of 55 km/h, never
dropping to a crawl, with one contact across the fourteen.

### And then it was switched off again, for an interaction

It was switched on, and the whole-force rig appeared to agree: near 71% and 74%
with the gaps against 64% and 60% without, both orders, arms that did not overlap.

That comparison was wrong, and the way it was wrong is the lesson. It toggled the
gaps and left the driver trusting its route as clear in *both* arms, so the second
half of the change was never varied at all. And the rig did not count damage, which
is the one number that would have shown it. "They seem to crash way more, like way
more." Done properly, six routes each:

| | contacts | hard | worst damage | near | nearest unit |
|---|---|---|---|---|---|
| gaps + route trust | **71** | 2 | **0.49** | 58% | 86 m |
| gaps only | 9 | 0 | 0.03 | 63% | 73 m |
| route trust only | 14 | 0 | 0.00 | 69% | 63 m |
| **neither** | 22 | 0 | 0.04 | **77%** | **56 m** |

Either change on its own *reduces* contacts. Together they treble them, do real
damage, and leave the force further away than with neither. That is an interaction,
and it is why neither single-factor test caught it.

The mechanism is specific. A cut is a tight corridor; `_pathClear` sweeps the route
and reports it clear; the car commits at speed. But a cut is verified to
`VERIFY_HALF` -- about forty centimetres of slack either side -- and the corner
rounding in `pathToPoints` moves the line by more than that. A cautious unit
survived the discrepancy because it was braking for the wall anyway. A committed
one clips the brickwork.

So both go back off: `CUTS_ON` is false and route-following speed comes off the
straight probes again, which is the state this had before any of it. The gap
machinery is all kept and still measured by `tests/gap.js` -- 13 of 14 driven at a
mean of 55 km/h -- and the thing to fix before turning it on again is the one named
above: verify a cut as the driver will actually be handed it, smoothed and with the
lane offset applied, rather than as the search produced it.

Two smaller things worth keeping from the attempt. `Driver.caps`, which made every
"why is it slow here" question readable instead of guessable. And the realisation
that the road rigs could not have found this: they build their officers by hand and
drive them straight at the target, so path following -- the thing that changed --
barely runs in them. The force rig is the only one where it dominates, and it was
the only one not counting crashes.

### Believing your own width, except when choosing a gap

*"They keep on crashing."*

They were, and it was the gap change above doing it. Letting a unit believe it is
80% of its real width was applied to *every* probe in the driver, including the
ones that brake for scenery and steer away from it -- and that is not being brave
about a gap, it is a car that has stopped believing its own width while deciding
whether it is about to hit a building.

What made it legible was separating a scrape from a crash. "Contacts" counts both,
and the whole point of the gap change was to accept scrapes, so the number going up
looked like the change working. Counting impacts hard enough to stop a car, and
cars destroyed outright, says something different. Four routes behind a 150 km/h
ghost:

| believed width | contacts | hard | wrecked | worst damage | left behind |
|---|---|---|---|---|---|
| its real one | 10 | **0** | **0** | 0.44 | 233 m |
| 90% of it | 22 | 3 | 1 | 1.00 | 177 m |
| 80% of it | 23 | 2 | 1 | 1.00 | 169 m |

At its real width, nothing hard and nothing written off. At 80%, a unit destroyed.
That is what reached the player, and the road rig had been saying so for two days
in a column nobody was reading: contacts had gone from 10 to 23 and were waved
through as the intended cost of being less careful.

The split is the fix, and it is the distinction that should have been there from the
start. `pickGap`, `planTrajectory` and `planThrough` choose a line -- they may
believe the car is narrow and commit to a gap it cannot quite clear, because the
scrape is the point. `clearAhead`, `_avoidScenery` and `_pathClear` decide whether
to brake and which way to steer -- they use the real figure, because a car that
lies to itself there does not scrape, it crashes.

With that, no arm of the road rig has a single hard impact or a single wreck, and
the squeeze is now straightforwardly worth having rather than a trade:

| | contacts | hard | wrecked | left behind |
|---|---|---|---|---|
| real width, 150 km/h ghost | 31 | 0 | 0 | 242 m |
| **80% for choosing, 150 km/h** | **18** | **0** | **0** | **158 m** |

Eighty-four metres closer, fewer contacts, and none of them hard. The gaps are
unaffected -- still 13 of 14 driven through at a mean of 55 km/h, and the one
contact in fourteen is now none. The weave rig gives back about a second and a half
of hanging on, which is the honest price of honest avoidance.

### The trees, and what the probes were allowed to see

*"They still seem to crash into trees a lot... I wonder if they don't know the size
of their cars."*

They know their size. The swept plate every probe uses is the car's own width --
`halfWidth` is half the collider plus ten centimetres -- and it starts at
`dims.l * 0.45` with a 0.25 m half-depth, so its front face lands within four
centimetres of the real nose. That was worth checking and it was not the problem.
What was wrong is what the probes were allowed to *see*.

Trees are `GROUP.PROP`, and `RAY_SOLID` is terrain and buildings only. Probed
straight at a trunk from 30 m: **`RAY_SOLID` reports the full 60 m clear** while
`RAY_GROUNDS` finds it at 28.9. `Driver._pathClear` -- the clamp that decides how
fast the route ahead can be taken, added the day before -- was written with
`RAY_SOLID`, copied from the wall clamp without thinking about it. The probe it
replaced used `RAY_GROUNDS` and did see trees. So every tree on a unit's route
became invisible to the one thing that sets its speed.

The second one is older and subtler. `clearAhead` threaded three rays -- centre and
either shoulder -- to catch the building corner a single centre ray misses. A trunk
is narrower than the 1.1 m between them: from 30 m the centre ray found it at 29.1
and **both shoulder rays reported nothing at all in 60 m**. Slide the trunk a foot
off centre and all three miss. One swept box of the car's cross-section catches it
at 28.9, is the question actually being asked, and is one shape cast where there
were three rays. It is also *less* conservative where it matters, because a ray
offset to the shoulder reports trees the car will drive past: crossing a wood went
from 15 km/h to 47 and the share of the run stopped from 61% to 23%.

The third is a lesson in this file being right in one place and wrong in another.
The last-resort brake clamp deliberately ignores trees, because there is a tree
beside every other street and braking for one is braking for nothing -- counting
them everywhere took the road rig from 11 contacts to 32 at a 150 km/h ghost and
wrecked two cars, since a unit that hauls the speed off mid-corner for a trunk it
was never going to touch is a unit that loses the back end. Among the trunks it is
the opposite: a wood is the one place a tree *is* the thing in front of you. So it
now counts them when the car is off the carriageway and not when it is on one,
which costs nothing on the road and takes the tree contacts in a wood from three to
one at exactly the same mean speed.

Six crossings of the densest wood on the map, 38 trunks thick, at 80 km/h:

| | contacts | of them trees | mean speed | stopped |
|---|---|---|---|---|
| as shipped | 2 | 1 | 15 km/h | 61% |
| swept probe, clamp still blind | 3 | 3 | 47 km/h | 26% |
| **swept probe, clamp sees trees off-road** | **1** | **1** | **47 km/h** | **23%** |

Same number of trees touched as the version that crawled, at three times the speed.
The roads are unchanged -- twelve contacts against eleven at a 150 km/h ghost, and
nothing wrecked in either.

One note on measuring this at all: the road rigs cannot. Their routes are on roads,
so what gets hit there is kerbs and other police cars -- at a 150 km/h ghost,
seventeen contacts over four routes and not one of them a tree or a building. That
is why `tests/trees.js` exists, and why the rigs now attribute a contact to a tree
or a wall instead of just counting it.

### Paving is not grass, and a gap is not a verge

Two more from the same report: *"when there's a tight gap, the police seem to slow
down loads"*, and *"there's just one single tree, and they hit it"* -- in a paved
courtyard.

Both are the same mistake in two places. `_offRoadNow` asks whether the wheels are
on *grass*, which is the right question for grip, and it was being used for two
questions that are not about grip:

- the brake clamp counts trees only when off the carriageway -- but a courtyard, a
  car park and a paved yard are surface 2, not grass, so the clamp stayed blind
  exactly where the single tree was;
- the "road is running out, slow for the verge" clause releases once the car is off
  the road -- but on paving it never released, so a unit threading a paved gap was
  held to an arriving-at-the-verge pace the whole way through. It bound 23% of the
  time a car spent inside one.

`_onCarriageway` is the question those two actually wanted: is there a road under
the wheels. Separately, the straight probe toward the aim point was binding 60% of
the time in a gap, and `pickGap` had already swept a box the car's own width along
the heading it chose -- the same question, better aimed -- so that measurement is
now used when the aim point came from it.

Driving straight at something through fourteen gaps, which is what a unit does for
most of a chase:

| | got through | mean in the gap | contacts | what was binding |
|---|---|---|---|---|
| before | 9/14 | 75 km/h | 4 | aim probe 60%, runout 23% |
| **after** | **14/14** | 75 km/h | **1** | nothing over 35% |

All fourteen negotiated instead of nine, contacts down from four to one, and no
single clamp dominating any more.

### Do they have 100% grip?

*"I don't know why they don't go faster through the turns. Do they have like 100%
grip? Maybe just give them 100% grip."*

They effectively have more than that. `cornerSpeedLimit` is `sqrt(mu g r)` with no
margin of its own, a pursuit driver's `skill.grip` is 1.08, and the only haircut in
the chain is `MU_TRUST` at 0.87 -- so the figure they plan against is 0.94 of the
tyre close up, and the rubber band's extra grip takes it a third past 1 at full
stretch.

And the rigs now say what they actually use. In corners on the roads it is **62% of
what is available**, and the clamp in force is the pure-pursuit arc 36-48% of the
time, the wall clamp 16-24%, the turn-back clamp 8-12%. They are not grip-limited at
all, which is why handing them more does not help:

| planned against | mean | behind | contacts | wrecked | worst damage | tyre used |
|---|---|---|---|---|---|---|
| **0.87** | **68** | **134 m** | 20 | **0** | 0.44 | 62% |
| 0.95 | 64 | 188 m | 22 | 1 | **1.00** | 66% |
| 1.03 | 58 | 258 m | 15 | 0 | 0.83 | 63% |

More grip makes them slower *and* crashier. The usage barely moves because the
binding constraint is elsewhere; all a bigger number buys is corners entered faster
than they can be held, and the time lost gathering the car up exceeds the time saved.
At 0.95 a car is written off outright.

Which leaves the pure-pursuit arc as the thing that actually limits a corner, and
four attempts on it are now recorded in this file: the plan's own radius (worse on
roads, a unit destroyed), a grip-limited planner fan (transformed one route, ruined
the tightest), a longer lookahead (moved speed and contacts, moved hanging-on not at
all), and simply believing more grip (above). The honest state of it is that nobody
has found a way to relax that clamp that does not cost more than it returns.

### Turning the grip up, and why it stays where it is

With the balance, the easing and the partial belief in place, the obvious next
question is how much further the bonus can go. *"Yeah turn the grip up more and
measure it."* The answer is that it does not go further, and the measurement is
clean enough to be worth keeping.

Six routes weaving through a housing estate, extra grip at full stretch:

| | stayed | held on | left behind | contacts | mean |
|---|---|---|---|---|---|
| 0.35 | 33% | 8.8 s | 137 m | 12 | 59 |
| 0.70 | 34% | 8.6 s | 135 m | 10 | 60 |
| 1.05 | 35% | 8.3 s | **124 m** | 16 | **64** |
| 1.40 | **37%** | **9.3 s** | 145 m | 15 | 59 |

In the gaps it genuinely helps, and nothing loses control at any level -- the
spins stay at three or four and the sliding at one per cent throughout, which is
the balance fix doing its job. On a road it is a different story. Four routes
behind a 150 km/h ghost, alternating the two settings so the noise is visible
rather than inferred:

| | with it | behind | contacts | sliding | lost the back end |
|---|---|---|---|---|---|
| 0.35 | 29% | 179 m | 16 | 4% | 3x |
| 1.05 | 27% | 179 m | 29 | 7% | 7x |
| 0.35 | 29% | 144 m | 10 | 4% | 3x |
| 1.05 | 26% | 236 m | 22 | 7% | 9x |

The sliding and the spins repeat to the figure. The contacts roughly double. And
nothing comes back for it: time spent with the car is flat to slightly worse, and
the finishing distance is noise in both directions.

Which says something about what the band is for. Tyre force stopped being the
constraint as soon as there was enough of it to hold the line the driver is
asking for. Past that point more grip only raises the speed the driver commits
to, because `Driver._mu()` reads it -- and that speed is spent arriving at the
next corner too fast. Partial belief is what bounds the overcommitment, and
raising the grip raises the believed figure in proportion, which hands it back.
Three attempts in this file have now tried to buy cornering with a bigger number
and the useful ones have all been about *balance* instead: which axle gets it,
how fast it may change, and how much of it the driver is allowed to count on.

### Narrow enough, if you do not mind the scrape

The gaps complaint is a different thing and the simplest fix in this whole
section. Every probe that looks for a way through swept the car's real footprint
plus a 10 cm margin, so a gap a hand's breadth too narrow read as a wall and the
unit went round -- while the player goes through it, clips the brickwork and
carries on. The scrape is not the disaster the sweep treats it as: units on their
way in are shielded precisely so a knock costs them time rather than their chase.

So for deciding where to go, a unit now believes it is 80% of its real width and
will commit to a gap it cannot quite clear. The collision still happens, which is
the point. Weaving through a housing estate behind a ghost at 110 km/h, six
routes:

| | held on | left behind | contacts | mean speed |
|---|---|---|---|---|
| its true width | 6.8 s | 151 m | 10 | 55 km/h |
| **80% of it** | **9.0 s** | **138 m** | 12 | **60 km/h** |
| 65% of it | 9.7 s | 145 m | 14 | 58 km/h |

Two and a bit extra seconds of staying with the car for two more scrapes, and it
helps on the roads as well -- at a 150 km/h ghost the pack finishes 156 m back
instead of 235. 65% hangs on a little longer still and gives back the distance and
the speed, so 80% is the number. This is the one change in the whole file where
being *less* careful was straightforwardly right.

### The whole force, not two cars told to follow

Every rig before this one builds its police by hand and tells them to chase.
That measures following, and following is not the force's only answer: the
dispatcher predicts where the car will be and sends units to junctions it can
beat it to, and at five stars the rules allow five pursuers and six of those.
`tests/force.js` steps the whole game instead -- spawning, heat, roles, radio,
air support -- with only the player on rails.

It immediately found a bug in all three rigs rather than in the game. They set
the ghost's velocity *after* reading its state, so `forwardSpeed` was derived
from the velocity `teleport` had just cleared and the car read as stationary to
anything that asked how fast it was going. The rolling block and the head-on van
both want more than 12 m/s and so never fired once in a whole run; the box's
"slow enough to surround" test was permanently true. Putting the two lines in
the right order moved the nearest unit from 251 m to 127 m -- which is to say
most of what the rig had been reporting as the force failing was the force never
being allowed to try.

What it says once it is honest: with air support on station the dispatcher knows
where the car is essentially all of the time, so this is not a problem of
losing sight -- and the force still averages 127 m behind. The intercept solver
is where it goes wrong. It finds candidate junctions every time, and then
rejects unit after unit for want of margin, 114 to 226 times for every one it
places, because against a car doing 110 km/h through a town no unit can beat it
to anywhere. Two thirds of the force falls through to RESPOND, which means
driving at where the car is, from behind, which is hopeless. The runs with the
most INTERCEPT are the runs where the force stays closest: 27% of unit-time on
intercept keeps the nearest unit at 91 m, 11% leaves it at 213 m.

So the window is the obvious thing to widen, and widening it is not the answer.
Nor is anything else done to it. Eight routes each, sight held so the rig is
measuring the orders and not the noisier question of whether they can see you:

| | near | mean nearest | someone in front |
|---|---|---|---|
| as committed | 36% | 130 m | 53% |
| 45 s horizon, 32 s margin | 36% | 130 m | 53% |
| a junction up to 9 s late still taken | 33% | 124 m | 55% |
| shortlist by what it could nearly make | 37% | 129 m | 52% |
| four more interceptors | 36% | 130 m | 53% |
| 3-to-12 s window | 23% | 149 m | 44% |

Allowing a late arrival is the one with a real argument behind it: a unit that
cannot quite beat them there is still better pointed at a junction ahead of them
than at a point they have already left, which is what RESPOND does. It comes out
neutral. Four more interceptors takes the over-limit refusals to zero and
changes the outcome not at all. Ranking the shortlist by how nearly each
junction could be made, rather than by how close it is -- on the reasoning that
the junctions nearest a unit behind the target are exactly the ones the target
gets to first -- actually places *fewer*, 129 against 140, because in a town of
crooked lanes a straight line is a bad guess at road time. Narrowing the window
is much worse.

**The car goes past 11% of the junctions units are sent to.** That is the number
that explains all six. The margin arithmetic is sound; the predictions it works
from are not. `RoadGraph.predict` walks the road network, and a car cutting
through gardens and car parks is not on it, so the units are being placed
correctly at the wrong junctions and no amount of placing them better can help.

Two attempts at fixing the prediction itself, both worse:

A car weaving between buildings makes far less ground than it covers. Measured on
the paths the rig threads through a housing estate, net displacement over fifteen
seconds is 0.21 to 0.47 of the distance actually driven -- 110 km/h of driving is
about 45 km/h of getting anywhere. The prediction is handed the speedometer
reading, so every junction comes out over twice too far up the road. Feeding it
the truer rate instead, from where the car was six seconds ago against where it
is now, moved accuracy from 11% to 9% and the chase slightly the wrong way.
Adding candidates from a cone ahead of the car rather than along the roads was
worse still, 5% -- for the same reason the helicopter is better off circling the
last sighting than running on down the last heading. A weaving car does not go
where it is pointing.

Which is the honest end of it: where the car will be fifteen seconds from now,
when it is threading a housing estate, is not knowable to within a junction. The
intercept is the right idea on a road and cannot be made to work off one. What
closed the gap instead was grip -- the section above -- and that is a different
kind of answer: not knowing where they will be, just being able to cover the
ground once you do.

All five parameters are left as fields with the committed defaults, along with
the counters and the prediction-accuracy figure that showed this, so the next
attempt starts from the measurement rather than from the same guess.

Two warnings about this rig, both learned the hard way. It is much noisier than
the others: the same settings measured twice gave the dispatcher seeing the
target 100% of one batch and 49% of the next, because spawn positions and the
aircraft's approach draw on the game's rng and the physics world carries state
between runs. Reseeding the rng per run fixes the detection half of that and not
the rest, so it is a diagnostic instrument rather than a way to judge small
changes -- the two rigs above are for that. And the air search looks like an
obvious defect and is not: hunting expands the search at 4 m/s round the last
sighting while a car doing 110 km/h leaves at 30, so on paper it can never catch
up. Making it run on along the last known heading instead, at half the last
known speed, measured clearly *worse* -- found the car again in one run of six
against three or four -- because a car weaving through gaps makes far less
ground than its speed suggests, and the small circle round where it was last
seen is a better bet than the direction it was last going.

### Something in hand

*"At high speed they seem to turn too much, a little bit, and then completely
lose control... they don't need to overcorrect. As long as they stay roughly on
me."*

The steering command is normalised against the lock currently available, not
the absolute maximum — and the available lock shrinks with speed, so the same
small heading error produces a far bigger command at 150 km/h than at 50. That
figure already has the spec's overshoot built into it, so a command of 1 is
asking for rather more than the tyres have. Measured in pursuit, 13% of frames
above 80 km/h were sitting at full lock: at the limit already, with nothing
left for a kerb, a verge or another car.

So the command is capped below full once the car is moving — 0.82 of what is
available, faded in between 50 and 115 km/h. A few degrees off line costs
nothing; the recovery from a spin costs the chase.

The ordinary rig could not see this at all, because a ghost holding a perfect
line never asks a unit to change its mind and a player never holds one.
`tests/keepup.js` can weave the target now, which is what overtaking parked
cars looks like from behind. Against a weaving target at 130 km/h, three
routes, with and without:

| at speed | without | with |
|---|---|---|
| at full lock | 11% | **6%** |
| losing it (slip > 15°) | 2% | **1%** |
| spun (slip > 25°) | **1%** | **0%** |
| contacts | 20 | **15** |
| time within 60 m | 32% | 32% |

Spins gone, a quarter fewer contacts, the same time on the target, for 3 km/h
of average speed and 23 m of distance. That is the trade that was asked for.

### Turning round, and the sine that did not care which way

*"If the police car is on a street to the right of me and a bit in front, they
try to turn around and they just hit a building."*

The pure-pursuit speed limit works off the arc through the aim point, radius
`Ld / (2 sin alpha)`. The sine is the same at 170 degrees as it is at 10. So
for a unit that has to turn *round* — pointing up a side street with the
suspect going past the end of it — the formula reported an enormous radius and
applied no limit at all, exactly where the car needed to slow more than
anywhere else. It arrived at the turn flat out and put itself into the building
on the far side. Every run of the U-turn case in `tests/sidestreet.js` hit
something.

Past a right angle there is no arc worth the name: the car has to come round,
and it can only do that at a speed its own turning circle fits. So beyond about
100 degrees the limit is the tightest turn the driver believes in, and the
ordinary braking gets it there.

Seven U-turn approaches: contacts 4 down to 2. And it is not a special case
paid for by the ordinary chase — over four routes against a 120 km/h target,
with the cap and without, run back to back:

| | mean | with it | behind | contacts | worst damage |
|---|---|---|---|---|---|
| without | 58 km/h | 36% | 152 m | 52 | 1.00 — written off |
| with | 53 km/h | 32% | **138 m** | **22** | 0.45 |

Five km/h slower and nearer the car anyway, with less than half the contacts
and nothing wrecked. After six attempts at the pursuit that all traded speed
for crashes in one direction or the other, this is the first that buys both —
because it is not a tuning choice, it is a term that was missing.

### Where the time actually goes

The ceiling measurement says the speed limiter is not the constraint. So where
does a pursuit lose its time? Sampled over a chase, bucketed by speed:

| speed | share of the chase |
|---|---|
| 0–20 km/h | **28%** |
| 20–40 | 12% |
| 40–60 | 21% |
| 60–80 | 14% |
| 80–100 | 18% |
| over 100 | 5% |

**More than a quarter of the pursuit is spent under 20 km/h.** And in those
frames: 61% off the road, 42% within two seconds of a crash, 36% reversing.

That is the answer to "why are they so slow", and it is not cornering, not
aiming and not planning. They crash, end up in a field, and spend several
seconds extracting themselves, over and over. The other half of it shows in the
frames where the limiter is *not* binding — 47% of the chase, with 77 km/h
available and 36 km/h on the clock — where the car is in first gear at 82%
throttle making 2.1 m/s², which is less than half what it can do. It is not
holding back. It is climbing out of a hole.

Shortening the recovery was the obvious next thing and it does not help: the
unstick waits 1.2 s, reverses for up to 2.6 s and stops after 7 m, and taking
that to 0.7 s, 1.6 s and 4 m gives 58 km/h against 61, 119 m behind against
108, with contacts down from 28 to 21. Flat to slightly worse, because the time
is not going on the reverse manoeuvre — it is going on being off the road at
all.

So the chain is: cutting across country causes the crashes, the crashes cause
the off-road crawl, and the crawl is a quarter of the chase. Keeping them on
the roads fixes the crashes and loses more than it gains (the committed line,
below). That is the knot, and seven attempts have not untied it.

### The band, doubled and shortened

With the six fixes all failed, the remaining honest move is a cheat that says
it is one. The rubber band already existed; it was reaching full stretch at
250 m, which is further behind than any unit still in a chase ever gets. At the
hundred-odd metres they actually sit at it was handing out about a third more
power while the number on the tin said three quarters. It reaches full stretch
at 160 m now and is worth twice as much there.

What that buys, measured over four routes against a 120 km/h target with the
old and new settings run back to back: **130 m behind becomes 116**. That is
all of it. Average speed does not move — 59 km/h either way — and nor does the
share of the run spent within 60 m. Contacts go up, 24 to 31, because a car
with more power arrives at the same corner faster.

Fourteen metres for a quarter more crashes. Worth having, because the
complaint is that they are too far away and this is the only thing that moved
that number at all, but it is a small thing honestly measured — and an earlier
reading that showed it buying five km/h as well did not survive running the two
settings one after the other instead of in separate sessions.

What it cannot do is help with cornering, which is what actually limits them,
so it buys back the straights and nothing else. And none of it reaches inside
30 m: the part of the chase you can see is still fought on the same physics
you are.

### A committed line, tried and not kept

The one the evidence pointed at, and the one that fails most clearly. If the
trouble is that a unit re-decides its aim every sixtieth of a second and so
never has a line, give it one: beyond contact range, route to the junction
nearest where the target is heading and follow that path, the way a unit going
anywhere else already does. The path supplies an aim point with a lookahead
along the road instead of a bearing to a moving car, and `planSpeed` gets a
corner it can see coming and brake for in advance rather than discover.

Over four routes against a 120 km/h target: mean speed 58 km/h down to 44,
within 60 m of the target 34% of the time down to 30, and 107 m behind becoming
188. Contacts halved, 29 to 15 — which is the tell. **Driving properly is the
problem.** A road route is longer than the straight line, and a unit that goes
round the houses politely while the car it is chasing cuts the corner arrives
late however well it drove. The direct line is wrong in every way except the
one that decides a pursuit.

### What is left

Six levers measured and rejected: `limitScale` (a direct pursuit never reads
it), `offRoadArc` (noise), `arcFloor` (helps at 120, catastrophic at 150 — 49
km/h down to 30 and one hit up to sixteen), the trail, the standoff point and
the committed line.

The diagnosis is not in doubt — a unit aiming at the car it is chasing is
asking for a corner, and the limiter is right to charge it for one. What the
six attempts establish is that it is not a tuning problem and not an aim-point
problem. Every way of making the line smoother makes the line *longer*, and
the pursuit is lost on distance before it is won on tidiness.

That leaves three honest options, none of them small:

* **Accept it.** Against a real player — who brakes for corners, and crashes —
  they are not as far off as the rig suggests. The rig's ghost drives a perfect
  line at a constant speed and never makes a mistake, which nobody does.
* **Give them a declared advantage.** Taken, and declared: see below.
* ~~**Rebuild the pursuit as a real planner.**~~ Measured, and it would not
  help. See below.

`tests/keepup.js` is the rig. Its ghost follows the roads' own polylines rather
than the chords between junctions — the first version cut every bend, so the
thing being chased was not driving on the road and nothing measured against it
meant anything.

### More grip on the grass, tried and not kept

*"If you think it will help the routing system, you could improve grip for the
police cars on off-road."* It does not, and the measurement is worth keeping
because the idea is a reasonable one. The fleet's `offRoadGrip` went up about
11% (an interceptor 1.85 → 2.05) and the same copse, both settings run inside
one session so nothing else differs:

| | hits in 40 s | worst impact | mean speed through the copse | damage |
|---|---|---|---|---|
| as it is | 2 | 9.5 m/s at 65 km/h | 14 km/h | 1% |
| with more grip | 6 | 35.1 m/s at 102 km/h | 40 km/h | 57% |

They spend the extra grip on speed and then bin it. Nearly three times the pace
through a wood, three times the contacts, and one of the two cars more than
half wrecked. The grip is where it was.

### Asking the grass for tarmac grip

The steering limiter sizes the available lock to what the tyres could actually
use at this speed: the Ackermann angle for `latLimit`, the lateral
acceleration it plans for. That figure is a tarmac figure -- 14.6 m/s², about
1.5 g -- and it was applied whatever was under the car. Grass gives a police
car about two thirds of it, so out there the limiter was handing the driver
enough lock to ask the ground for half as much grip again as it had. A car that
turns in on that promise loses the back end and goes round.

It is scaled by the surface now (`Vehicle.surfaceMu` over the road's own mu,
floored at 0.45), so the car cannot ask the grass for more than the grass has,
and tarmac is untouched because there the ratio is one -- measured, seven units
in a city chase drive at the same 61–78 km/h with the same 0.17–0.24 rad of
lock as before.

In the copse `tests/woods.js` runs in, the hits over forty seconds went from
four to three. Two further changes were tried on top and both measured worse,
so neither is in the game: lifting off sooner and harder on the loose (onset at
eleven degrees of body slip instead of twenty, with counter-steer scaled up to
match) came out at four hits, and the full-stop the plan cap asked for when all
four wheels were momentarily off the ground was worse than useless.

### The lock a wood needs

*"Police cars still seem to hit trees even when they have loads of time to
react... you could make them be able to turn tighter at higher speed if you
want."*

Measuring this took longer than fixing it, because `tests/woods.js` was not
measuring it at all. It used to chase the player's own car through the copse
for forty seconds. The player drove into the first trunk at about two seconds
— 90 km/h, then 39, then stopped — and the remaining thirty-seven seconds were
two police cars parked behind a stationary car in a wood. "0 hits, mean 10 km/h"
read like a flawless drive and was two cars that never went anywhere. The test
now chases a ghost: a point carried along a straight line through the middle of
the copse at a fixed speed, which cannot crash, so the pursuit lasts as long as
the wood does and every car in the count is a police car doing its own driving.

With something real to look at, the fault is not what it looked like. The cars
are not sliding into trunks — body slip is under six degrees nine tenths of the
time — they are *braking*. A unit threading trunks at 50 km/h was being handed
about fifteen degrees of a thirty-one degree wheel, so one that wanted to go
round a tree could not turn tightly enough to, and stopped instead: on the
brakes a quarter of the time, averaging 41 km/h, and still clipping trunks at
walking pace while it shuffled about. One frame in six had the driver asking
for full lock against the limiter.

So the fleet sizes its lock for more than it will really pull, but only on the
loose, where it has the tyres for it. Understeering past a trunk with the wheel
further over is worse cornering and better driving: you scrub, but you miss it.
`offRoadLatLimit` is 18.5 m/s² against the road figure's 14.6, and it was
picked by sweeping it: 16.5 was not enough to show, 18.5 was the best of them,
and past about 21 it went the way the extra grip went — spent on speed and then
binned, six hits instead of three.

It is an improvement, not a transformation, and it is worth being exact about
the size of it. Fifteen approaches through the copse at three target speeds,
run twice on different days:

| | hits | mean speed | ground lost to the target |
|---|---|---|---|
| the road figure everywhere | 13, then 12 | 45 km/h, 47 | 341 m, 332 |
| with the off-road allowance | 10, then 10 | 49 km/h, 47 | 315 m, 331 |

About a fifth fewer contacts, both times, for about the same pace. The cars
still hit trees; they hit fewer of them.

One number moved more than the rest and it is the one that says why: at a 70
km/h target — the speed where the trunks come up quickest relative to how hard
the car has to turn — it is five hits to four, 35 km/h to 39, and 26 m less
ground lost.

It cannot touch the road. The branch is only reached when a wheel that is
carrying the car is on grass, so `tests/policeturn.js` comes back byte for byte
identical with it on and off, and a five-leg route across the city with
off-road cutting allowed differs by a tenth of a second in 339. The van does
not get it: three and a half tonnes of box is not threading a wood, and an
allowance it was never measured with is not worth the risk of standing it on
its side.

What is left of the problem is the worst impact, and it is worth writing down
what it actually is: a unit at seventy-nine degrees of slip -- travelling very
nearly sideways at 23 km/h -- meeting a trunk three metres in front of it. The
velocity change reported for that is 31 m/s because the figure includes the
spin the trunk stopped. It is not a car that drove into a tree; it is a car
that had already lost it, and the tree is simply what was there.

### Braking only for what is in the way

The obstacle sweep casts three swept boxes: one straight ahead and one
twenty-four degrees either side. All three were feeding the braking distance —
and the angled pair point at the kerb. On a fifteen-metre street they run into
the buildings alongside at about twenty metres with the way ahead completely
clear, so cars were hauling down to 50 km/h for a building they were never
going to touch.

Only the straight-ahead sweep sets the braking distance now. The angled pair
exist to say which side has more room, and that is all they do:

| | before | after |
|---|---|---|
| median pursuit speed | 49.2 km/h | **60.2 km/h** |
| nearest unit, median | 29.6 m | **14.6 m** |
| someone within 60 m | 69.4% | **85.4%** |
| scenery impacts /car-min | 0.12 | 0.12 |

Faster, closer, and no more likely to hit anything — the braking was pure loss.

### Seeing far enough to go fast

*"Even on wanted level five, I can just floor it on a straight road, and they
will just lag behind so far. How fast can the police cars go?"* Faster than the
car asking, as it turns out. Flat out on the flat plate, with nothing in the
way and no corner to take:

| | 0–100 km/h | top speed |
|---|---|---|
| Stiletto (the fast one) | 5.05 s | 240 km/h |
| Runner | 7.37 s | 215 km/h |
| Patrol | 6.38 s | 230 km/h |
| Interceptor | 5.93 s | 241 km/h |
| Unmarked | 5.52 s | 247 km/h |

So the cars were never the problem. The problem was that a police driver may
only go as fast as it can stop in what it can see, and it could only see 70 m.
That is an arithmetic speed limit: 63 usable metres at a police car's braking
gives about **206 km/h**, and no amount of open motorway in front of it made
any difference. A supercar at 240 simply left.

The probe now reaches as far as the speed actually requires — the car's own
stopping distance plus a margin, out to 220 m — so on genuinely open road the
rule stops binding at all, which is the right answer to "is there anything to
slow down for". Nothing else changed: same engines, same grip, same braking.
`tests/straightline.js` puts a unit 60 m behind a Stiletto held flat out, on
open road, for 30 s:

| chasing a Stiletto at 240 km/h | before | now |
|---|---|---|
| Patrol — gap after 30 s | 285 m | 113 m |
| Interceptor — gap after 30 s | 193 m | **66 m** |
| Unmarked — gap after 30 s | 214 m | **43 m, still closing** |
| what the interceptor settles at | 203 km/h | **247 km/h** |

In a full chase it shows up as the pursuit simply being *there*: over four
runs at four stars the nearest unit sat 6–26 m away instead of 90, with no
more scenery contacts (0.6 per minute) and no change in frame time — nine
units at five stars cost 3.85 ms a frame with the long probes against 4.15 ms
with the old ones, which is to say the rays are free and the braking was not.

What the Stiletto keeps is cornering: 1.50 g at 60 km/h and 1.64 g at 170,
against a police car's 1.30. It is no longer a car you escape in a straight
line; it is a car you escape in the bends.

### Cones

Roadblock cones are dynamic bodies of about 2.5 kg in their own collision
group, `DEBRIS`, which the AI's obstacle sweeps ignore entirely: a cone is
something you drive through, and a police car that brakes for one is worse than
useless. Driving through five of them at 90 km/h scatters them 1.6–3.2 m and
does **no damage at all**.

### Junctions

Every road is drawn as a ribbon of its own full width, which is fine for the
tarmac — tarmac on tarmac is invisible — but not for anything drawn on top of
it. Kerb lines used to run straight out across the middle of a crossroads and
lane dashes carried on through it.

`src/world/junctions.js` works out, for every approach to every node, how far
back its markings have to stop in order to clear the other roads. For two roads
crossing at angle θ the corner where their kerb lines meet sits
`otherHalfWidth / sin θ` along each of them, so that is the setback; it is
floored so a shallow crossing does not run away, and capped at a third of a
short road. Kerbs and centre lines are sliced to it, each signalised approach
gets a stop line, and the re-entrant corner where the two ribbons meet is
filled out to a kerb radius so the carriageways run into each other on a curve.

Three separate things made roads look like they did not join up, and all three
are fixed: `addRibbon` mitred without scaling the join, so the ribbon pinched
in at every bend and left a wedge of bare ground on the outside; ribbons end
square at their node, so a bend leaves a notch even with a correct mitre (a
small apron disc at each node covers it, since both ends pass through the
node); and corners that fell on a node stayed sharp, which `smoothBends` now
replaces with an arc, moving the node to the middle of it so it is still a real
point on the road.

### Crossings the graph did not know about

A junction only exists if two edges share a **node**. Two roads can cross on
screen and share nothing at all, and then the police cannot turn between them:
the route search is never offered the turn, so a unit drives over a crossroads
it cannot see and carries straight on. On the city that was 18 crossings,
including country roads over the ring motorway — which is why a unit would sail
past a way onto the motorway it could plainly have taken.

`RoadGraph.stitchCrossings` finds them. Every segment goes into a 60 m bucket
grid; each pair from neighbouring buckets that intersects in both interiors and
shares no node is a junction the graph is missing. If one of the four end nodes
is already within 7 m, the roads meet there in all but name and it is left
alone; otherwise a node is created at the crossing and both edges are rebuilt
as a chain through it, so the turn then exists for routing, for `planJunctions`
and for the signal heads alike.

It runs **twice**, before and after `smoothBends`/`smoothEdges`, because moving
geometry to round off a bend creates crossings that were not there when the
first pass looked.

| on the city | |
|---|---|
| crossings with no junction | 18 → 2 (after smoothing) → **0** |
| motorway nodes joined to an ordinary road | 12 → **17** |
| random cross-map routes that use the motorway | **18 of 39** |

Wexbury reports one, and it is a false positive: two roads that meet 5 m apart
through a short link edge, which routing uses like any other.

### Kerbs

The footway stands **140 mm** above the carriageway, and you can feel it. It
used to be a colour stripe — pavements were drawn *below* the road, and the
world's only collision geometry is one flat plate, so there was nothing to
drive over.

It is done with a **height field**, not geometry. `sim.heightAt(x, z)` says how
high the surface is; the suspension ray lifts its contact by that and tilts the
normal by the local gradient. Colliders for every footway in two towns would
have been thousands of static boxes, and would have dragged the AI's obstacle
sweeps and the wheel rays into caring about them. This costs four lookups a
wheel — and because the answer arrives *through the suspension*, the car gets
the bump, the weight transfer and the tyre's reply to all of it for free.

| mounting it at | suspension (87 mm at rest) | body lift |
|---|---|---|
| 4 m/s | — | — |
| 10 m/s | 90 mm | — |
| 18 m/s | 178 mm | — |
| 26 m/s | 185 mm, near the bump stop | 34 mm |

No speed lost and no damage from the kerb itself: it unsettles you, it does not
stop you. Driving along the road is unaffected — 3 mm of body movement down the
middle, and 3 mm hard in the gutter.

The surface grid went from 4 m cells to 1 m, because it now carries height as
well as grip and a kerb two metres from where it is drawn is very much
something you can feel. Measured: the ground rises at 7.10 m against a drawn
half width of 7.50. That is *cheaper* than before, not dearer — disc painting
used to step by the cell size, so metre cells laid down sixteen times the discs
for a scallop of six centimetres. Stepping by a quarter of the disc radius took
the map build to 2.5 s, against 3.0 s before any of this.

**Raising it breaks the road, and it is worth understanding why.** A footway
band runs *alongside* its own road, so it also runs straight across every road
that crosses it. Harmless while the footway is the lower of the two and the
carriageway draws over the overlap — invert that and every band paints over the
junction it passes through, turning a town of crossing roads into a patchwork
of grey slabs. **14.5% of the town's carriageway ended up under pavement.**

Trimming the bands back at the junction mouths is the obvious fix and it is not
enough: it only helps where two roads actually meet, and does nothing for a
bend, for two estate roads that run close by without ever crossing, or for a
roundabout sitting across the corner of a city block. Twice I looked at
screenshots and called it fixed. What settled it was measuring —
`tests/surfaces.js` fires 4,000 rays straight down onto the carriageway and
asks which surface is nearest the sky.

The first fix clipped everything raised against the surface grid, which had the
carriageways burned into it and so knew where footway was. It measured well —
carriageway drawn over went from 14.5% to 0.00% in Wexbury — and it looked
terrible. A pavement cut to fit a metre grid has a metre-grid edge: every
junction mouth and every bend in the town grew a **staircase of grey teeth**,
block plates in the city got stepped edges along every road through them, and
from a distance the whole town shimmered with them.

**So the pavement is no longer cut at all.** Pavement shapes are back to the
smooth ones from before the kerbs were raised — a full-width ribbon along each
town road, a plain plate across each city block — only now at kerb height. What
changed is the *drawing order* (`DRAW_ORDER` in `world/common.js`): grass, then
pavement, then tarmac, and the tarmac ignores the pavement's depth, which is
what a road painted onto the ground is anyway. Where road and pavement overlap,
the road shows; everywhere else, the pavement. The kerbs — the face and the
stone on top, which are what actually tell you the footway is raised — are
drawn after that with an ordinary depth test. The catch is a sliver: at a very
low angle a raised pavement edge should hide a few centimetres of road just
behind it, and the road draws over that edge instead. From a chase camera it
cannot be seen.

That moved the problem onto the kerbs, which were never right either:

* **Kerb lines across other roads.** A kerb ran the length of its road, trimmed
  back only at the junctions at its two ends — so wherever another road crossed
  it mid-length, merged into it or passed close by, the kerb carried straight on
  across that road's tarmac. Kerbs are now walked a metre at a time and dropped
  wherever the kerb itself, or the ground just behind it, lies on another
  road's carriageway, tested against the roads' actual shapes rather than the
  metre grid. The kerb round each junction corner gets the same test: where
  more than two roads meet, a corner can land on a third road's tarmac, and a
  kerb there was a U of stone standing in the middle of the junction.
* **Kerbs crossing in an X at bends.** A kerb drawn road-piece by road-piece
  ends at every node, so at a bend the two inside kerbs ran past each other and
  the two outside ones stopped short. Kerbs are now drawn along whole runs of
  road joined through plain bends, so the offset line mitres round the corner
  like any other ribbon. Two traps on the way: splitting the run into metre
  pieces put points so close to the bend that the kerb, drawn five metres out,
  folded back over itself — only the road's own vertices and the cut points go
  into the line now — and a road that doubled back on itself joined into a
  hairpin, which mitred into a kerb shot straight across the carriageway, so
  runs only continue through genuine bends. The kerb *face* was also offset
  without a mitre and cut every corner short of the stone on top of it; it
  mitres now too.
* **Corners.** The gaps between square road ends at a node were filled with a
  disc the size of the widest road there, which at a junction of an avenue and
  two narrower streets stood out past the streets' kerbs as a polygon of tarmac.
  They are filled with the exact wedge between the ends now, reaching out to the
  mitred corner on the outside of a bend. Corner kerbs are raised like the rest,
  where they used to be flat stripes.

| what you would see on the carriageway (`tests/surfaces.js`) | grid clipping | now |
|---|---|---|
| Wexbury | 0.00% covered, but a staircase everywhere | **0.00%**, smooth |
| the city | 0.13% | **0.00%** |

`tests/surfaces.js` now works out what would actually be *drawn* at each point,
taking the drawing order into account, rather than what is nearest the sky —
which means a kerb carried across somebody else's road now counts against it.
`tests/roadshots.js` photographs fixed places on each map by coordinates, so the
same views can be taken of any version of the game and compared; that is how
every one of the problems above was found. The height field is untouched by any
of this, so the kerb feels exactly as it did.

**This is the mechanism terrain would use.** Give `heightAt` a hill and cars
drive over it, pitching and rolling on the gradient, with nothing else
changing. The one number that has to keep up is `GROUND_RELIEF` in
`physics/vehicle.js` — how far the ground may stand above the flat plate, and
therefore how far the suspension ray has to reach. It is 1.0 m for kerbs and
would be the terrain's relief for hills. The visible ground plane would have to
follow the field as well, which it does not yet.

### Traffic signals

Junctions with three or more street-grade approaches get signals. Two phases,
split by bearing — on a crossroads that is exactly the two carriageways — and a
UK sequence: green 13 s, amber 3 s, all-red 1.7 s, then red-and-amber 1.6 s on
the other phase. Junctions are staggered by position, so they do not all change
together. Not where an approach is shorter than 24 m: the A361 crossroads into
Wexbury sits seven metres from a roundabout, and its stop lines landed at odd
angles in the middle of the junction. Nobody signals a junction that close to a
roundabout anyway, so that one and any like it are left unsignalled.

The head goes on the nearside kerb at the stop line, facing back up the
approach. With `DRIVE_SIDE = +1` the nearside for arriving traffic works out as
the `+perp` side, which is the same side the stop line is drawn on.

Both the head and the stop line follow the road's own polyline out from the
node rather than projecting along the tangent there. That distinction is not
academic now that bends are smoothed: an approach curves away from its
junction, and on Wexbury the tangent put **102 of 131 heads in the
carriageway**. There is a clearance check behind it that walks a head onto the
footway if it still lands on tarmac, and drops the approach rather than
planting a pole in the road.

Signal posts are knockable, like everything else on the kerb. A flattened
signal goes dark and stops being a signal — the lamps hide and `stopDistance`
returns `Infinity`, so a patrol treats that arm as unsignalised rather than
obeying a light lying in the gutter.

**Only patrolling units obey them.** A unit running to a shout, searching, or
already in a pursuit has blue lights on and goes through — the same rule that
governs whether it will leave the carriageway. A patrol brakes at 3.4 m/s², so
it eases to a halt rather than standing on the pedal.

| | |
|---|---|
| stopped, on red | **0.8 m before the line** |
| furthest past the line | **0.0 m** |
| moved on in the 8 s after green | **93.3 m** |

Cost is close to nothing: the poles and housings merge into one static mesh,
and each head's three lamps sit at a fixed slot in three instanced meshes, with
the unlit ones scaled to nothing rather than packed out of the list. A signal
changing writes three matrices. 702 heads on the city map come to about
0.16 ms a frame and three draw calls.

### Stuck behind you

A patrol car that finds your car stopped in its way pulls up close behind you
and waits. After five seconds it gives you a one-second blip of the lights and
the siren — move along — and says so on the radio. Ten seconds later, a second
blip and a last warning. Still there three seconds after that, and it is
obstruction: the car says so ("Two warnings and they still won't move. Lights
on, I'm stopping them."), Control puts out the call ("vehicle obstructing a
police officer"), and you are in a one-star chase with that car on your tail.
*"After the police say two things... wait three seconds... then just begin a
one star pursuit."* Drive off at any point before then and it follows you,
reports that you have moved on, and nothing comes of it. Only patrolling cars
do any of this — a unit that is after you has no reason to wait politely.

It used to drive into you. A patrol car's only answer to a car in its lane was a
steering nudge that lost to its own lane keeping, and nothing made it brake for
a car at all: measured with you stopped in its lane on a 20 m road, it drove
into the back of you at 43 km/h and shoved your car seventeen metres down the
street.

**Going round you — tried, removed.** *"Make it so if I'm not stopped in the
middle of the road, they go around me."* The first answer measured the tarmac
either side of you and pulled out round whichever side had room. In tests it
did go round, but it needed a guard against you moving, a follow mode for when
you rolled along, and a reverse-and-swing-out for corners, where it came out of
the turn nose-on to you and too close to steer round. *"Get rid of the trying to
go around me bit... just make it so the police guys just kind of get really
close to me and just stop."* What is left is the parts that were about not
hitting you:

* **Never into you** (`Driver.holdBehind`). Every frame the patrol car works
  out how long until it touches you if you both carry on as you are — each car
  as three circles down its length — and if that is inside three seconds it
  brakes so as to stop two metres short, on gentle braking so it starts early.
  Pull out in front of it, swerve across it, reverse at it: it stops.
* **In the way, it closes up and stops.** Your car in its line — measured along
  its route, not in a straight line, so a car parked just past a junction is
  seen from the far side of it rather than mid-turn — and it brakes to arrive
  two metres behind you. Moving, it follows instead, a couple of metres back
  plus a little for every metre a second you are doing.
* **Not in the way, it carries on.** Parked at the kerb or across the centre
  line leaves its lane clear, and it drives past in it.
* **Waiting at the lights is not blocking.** Stopped behind you at a red, with
  the stop line just past you, it queues and says nothing
  (`Officer._queueingAtLights`).

The blip is `vehicle.blipFor`: the lamps and the siren read it as well as the
wanted level, so one car can light up with nobody wanted. The siren is always
the yelp for it — a couple of whoops, not a wail starting up. The calls are
British traffic-officer patter ("Stationary vehicle, won't shift. Quick blast on
the twos.", "Driver's ignoring me. Might have to have a word."), a wording at a
time from each set so they do not repeat.

`tests/pass.js`, the patrol car arriving at 43 and 60 km/h:

| you | what it does | contacts |
|---|---|---|
| stopped in its lane | stops 1.8 m behind; blips at 5 s and 15 s; one-star chase at 18 s | **0** |
| stopped, then drive off after the first warning, or in the 3 s after the last | follows; "vehicle's moved on"; no chase | **0** |
| stopped in its lane, facing it | stops 1.9 m from your bonnet; the same warnings and chase | **0** |
| at the kerb, or on the centre line | drives past in its lane | **0** |
| creeping along its lane | follows about 5 m back | **0** |
| pull out from the kerb in front of it | brakes, follows | **0** |
| swerve across it at 14 m, 7 m, alongside | stops | **0** |
| drive off, then stand on the brakes in front of it | stops 1.7–3.3 m back | **0** |
| stopped just past a corner, 6 corners × 2 distances | stops about 2 m back, blips at 5 s (10 of 12; in the other 2 its route goes straight on at the junction instead of down your street) | **0** |
| waiting at a red light | queues behind you, says nothing; blips 5 s after it goes green if you don't | **0** |

### Street furniture

Lamp posts, bollards, bins and signs along the kerbs — 1608 of them on the city
map, 402 in the town. Standing, they are instanced meshes with a thin static
collider and cost nothing per frame. Hit one and it becomes a real dynamic body
that topples and slides, and the car takes the momentum it actually lost.

| | speed | damage |
|---|---|---|
| signal post (150 kg) | 20.5 → 17.8 m/s | +1.3% |
| lamp post (62 kg) | 23.7 → 22.5 m/s | +1.1% |
| bin (26 kg) | 24.7 → 23.8 m/s | +0.3% |
| bollard (24 kg) | 21.1 → 20.6 m/s | +0.2% |
| sign (18 kg) | 22.7 → 22.3 m/s | +1.3% |

*(Measured at 24 m/s, before bollards were made heavier — see below.)*

A shove and a scratch, not a wall. They live in `GROUP.STREET`, which no ray or
sweep in the game looks at — the police AI must not brake for a bollard and a
suspension ray must not climb a lamp post — so all the interaction happens in
`src/game/streetprops.js`, where it can be tuned. Toppled props stop being
simulated once they settle, and only the last 26 stay live at once.

The geometry is modelled with its base at the origin while the collider is
centred on the body, so a fallen prop's mesh sits half a height *below* its
body — along the body's own up axis, not the world's. Getting that wrong is
worth knowing about: subtracting on world Y is correct only while the prop is
upright, and once a lamp post is lying flat it buries it under the road by its
own length. Which way it fell decided how badly, which made it look like a
problem with one side of the street.

**Not a wall at 200.** *"I can do 200 miles an hour and they'll just stop me
dead."* They could. Knocking a prop over is decided once a frame, for anything
within 0.9 m of the car's nose — but physics runs up to five substeps in a
frame, and a fast car on a slow frame travels further than that before it is
checked again. It reached the post's static collider first, and a static
collider is an immovable wall. `tests/bollard.js` stands one bollard out past
the map edge and drives into it: at 60 frames a second everything was fine,
but at 30 — an ordinary phone — 230 km/h went to **21 km/h in one substep, and
the car was wrecked**. The check now sweeps the car's footprint along its
velocity for everything it will cover before the next check, so the prop goes
over before contact at any frame rate.

Asked for at the same time: *"they need to do damage and knock me back a bit."*
A bollard is now 95 kg rather than 24 (a real one is cast iron set in concrete)
with a little more bite, the knocked prop is sent off slightly faster than the
car so it is not hit a second time, and the speed loss no longer also gets
counted as a crash by the impact detector — the jolt and the thud are given
directly instead. Stiletto, straight on:

| | before, 60 fps | before, 30 fps | now, any frame rate |
|---|---|---|---|
| 100 km/h | −1 km/h, 0.5% | −1 km/h, 0.5% | −4 km/h, 2.3% |
| 190 km/h | −6 km/h, 1.0% | −8 km/h, 1.0% | −13 km/h, 4.4% |
| 230 km/h | −10 km/h, 1.2% | **−209 km/h, 100%** | −18 km/h, 5.3% |

### Knowing how big the car is

Every lateral check used to be a constant. Length and wheelbase were read from
the spec properly, but width was not: one shared 2.36 m sweep shape for every
car, clearance rays at a fixed 1.1 m, a car-avoidance clearance of 2.2 m, and
-- the one that actually showed -- a pursuit corridor cast at plus and minus
2.2 m, demanding a **4.4 m** opening for a car 1.94 m wide. Gaps between
buildings that a police car would drive straight through were declared blocked,
and the unit went the long way round by road.

All of it now comes from `spec.dims`, through one accessor (`Driver.halfWidth`)
that adds the margin a driver would want before committing to a gap at speed.
The sweep shape is built per width and cached, so a wider vehicle added later
probes as its own size rather than inheriting somebody else's.

Measured on a wall with a hole in it, for the 1.94 m patrol car:

| gap | verdict | drives through | touches the sides |
|---|---|---|---|
| 1.6 m | blocked | no | yes, if forced |
| 2.2 m | blocked | no | yes, if forced |
| 2.6 m | **clear** | **yes** | no |
| 3.2 m | clear | yes | no |
| 4.4 m | clear | yes | no |

The threshold is about 2.6 m -- roughly a third of a metre each side -- and
everything from there up to the old 4.4 m limit is newly available. Below the
car's own width it correctly refuses, and would scrape if made to try.

The roadblock's coverage maths also took its car size from literals, which
mattered more quietly: a wider vehicle would have left a gap up the middle of a
block it believed it had closed.

### Seeing what will actually fit

Every obstacle check used to be a ray, and a ray is a line with no width. A fan
of them threads either side of a tree, or clips past the corner of a building,
and reports open road — which is how a car two metres wide ends up wrapped
round a lamp post that nothing ever saw.

They now sweep the car's own footprint (`sweepBox`, over Rapier's `castShape`):
three swept boxes along the line of travel and a little either side, which give
both the distance to slow for and a side to steer toward. It asks the question
the car actually cares about — will *this* fit through there.

| scenery impacts /car-min | ray fan | swept box |
|---|---|---|
| Ashfield | 0.13 | **0.10** |
| Wexbury | 0.12 | **0.07** |

The swept box on its own measured 0.04 on both maps. The faster fleet engines
above cost a little of that back — more speed means more energy to get rid of —
and the widened probe recovers part of it. Every remaining contact on either map
is the rolling block.

One thing tried and rejected: extending the close-range speed clamp into a
general "be slow enough to turn within whatever you can see" rule. It reads as
obviously correct and made the city *worse* — there is a building about thirty
metres ahead at every junction, so units simply became timid, the nearest one
sat 50 m back instead of 25, and contacts went up as they bunched behind each
other.

### Keeping up

The patrol car — the one you meet most, and the only kind fielded below three
stars — was genuinely slower than the runner: 0–100 in 8.18 s against your 7.50,
and 9 km/h down after ten seconds. Flooring it simply left them behind, which is
not a chase. The fleet engines are up, and every car they field now
out-accelerates you:

| | 0–100 km/h | at 10 s | vs you |
|---|---|---|---|
| Runner (you) | 7.50 s | 123 km/h | — |
| Patrol | 6.98 s | 129 km/h | **+6** |
| Interceptor | 6.45 s | 135 km/h | **+12** |
| Unmarked | 5.97 s | 143 km/h | **+20** |

The verge is less of a cliff for you too. Bare grass at μ 0.62 feels like ice
the moment you clip it; the runner now gets `offRoadGrip` as well, taking it to
about 0.96 — enough to gather the car up rather than be a passenger. Still well
short of the fleet's 1.80, so they keep the advantage off the tarmac.

### Going straight at you

A unit in pursuit drives at you as the crow flies, at any range. Distance is not
a reason to take the roads and neither is the surface — grass, verges, playing
fields and car parks are all just ground, and a car crosses them at whatever
speed they will take. The only thing that sends a pursuer back to the road
network is something solid actually in the way.

The obstruction test is a **corridor, not a ray**. A single centre line
threading the gap between two buildings reads as clear for something with no
width; the car is two metres across and closing at whatever you are doing, and
it takes the corner of the building. Three lines a car's width apart is the
difference.

Measured over 120 s at four stars, against the same code with the old
"direct only within 85 m" rule:

| | by road beyond 85 m | crow flies |
|---|---|---|
| nearest unit, median | 64.7 m | **31.4 m** |
| someone within 60 m | 44.8% | **81.9%** |
| scenery impacts /car-min | 0.10 | 0.13 |
| median pursuit speed | 55.3 km/h | 58.6 km/h |

Half the distance, for two extra scenery contacts in two minutes across a
dozen cars. On Wexbury the nearest unit sits at a median of 21 m with someone
inside 60 m for 84% of the chase.

Note what is *not* in that change: intercepts, responses to a shout and patrols
still use the roads (searches no longer do — see *Searching off the road*). An
intercept's whole purpose is to get
somewhere you are not yet, and a unit crossing town to a position you were last
reported at is genuinely quicker on the network than in a straight line through
a housing estate.

### They do not copy your line — tried, removed

A unit that cannot see the car drives at it anyway, picking its way through
whatever is in between (above), and that is all it does. There was a version
that did something else: the game kept a breadcrumb trail of where the player
had actually driven, and a pursuing unit that found itself on that trail drove
it — the same gap, the same corner, at a speed planned from the trail's own
bends — the argument being that a straight line to a car that has just turned
past a house goes through the house.

Following someone's exact line turns out not to be tracking them. It is
copying them, and it copies everything, including the parts that were a
mistake:

* *"Sometimes I might accidentally skid a bit off road, but then continue on,
  and then they would always all skid off road."* The line went onto the verge,
  so every car in the pursuit went onto the verge, one after another.
* *"I went into the repair station and I backed out, and then they all started
  trying to go into the repair station."* The line went into the bay and out
  again, so the pursuit turned into the forecourt.

Both were narrowed first — only from right behind, only with no line of sight,
with doubling-back cut out of the trail — and then the whole thing came out:
*"I like the previous routing system actually."* The chase reads better with
units that are visibly making their own decisions, badly sometimes, than with
units that are visibly doing what you just did. The one case it was good at,
threading a gap directly behind you, `_driveDirect`'s gap fan and staging
point already handle.

What stayed from that work is the following distance. A pursuit converging on
one car converges on one line, with every unit on it closing on the car ahead
as if it were you: twenty police-on-police shunts a minute. So a unit with
another police car between it and you keeps a gap of seven metres plus about
half a second. Only the car at the front closes, and a unit alongside you
running a PIT does not count as being in the way.

### Ramming

*"The police also seem reluctant to ram me — make them ram me more, and increase
the closing speed at which they ram me and aggression as the wanted level
increases."*

Set up on its own (`tests/ram.js`: one interceptor forty metres behind a car
doing 70 km/h, nothing else on the map), a pursuer arrived, hit once, and then
sat on the bumper for the rest of the run at exactly your speed with its foot
flat down. That is a push, not a ram — nothing registers as an impact, and from
the driver's seat it is barely there. Now contact, or half a second of leaning
on you, sends the unit back for a run-up, and when it has one it comes again.

How hard a ram lands is mostly how much road the unit had to build up speed
on: starting four metres back it reaches your bumper at five or six metres a
second whatever it asks for. So the run-up is what scales with the wanted
level — a shove from 7.5 m at one star, a proper hit from 17 m at five — along
with the speed it asks for on the way in, from 20 km/h faster than you to
58 km/h. None of it is extra power; the charge is the car's own acceleration.
Nor does a unit back off a car that has stopped: that is an arrest, and it
stays against you.

Three runs of 30 s at each level:

| | before: hits per 30 s | now: hits per 30 s | closing speed at impact | knock on your car |
|---|---|---|---|---|
| one star | 1.0 | **5.3** | 7.1 m/s (26 km/h) | 4.1 m/s |
| three stars | 1.0 | **3.7** | 9.3 m/s (33 km/h) | 5.9 m/s |
| five stars | 0.7 | **4.0** | 9.9 m/s (36 km/h) | 6.2 m/s |

No scenery contacts by the pursuer in any of them. At one and two stars a unit
still sits slightly off to one side once close, lined up for a PIT; from three
it puts its nose straight at your boot. Either way it aims through the car
rather than at it — up to 2.6 m past your middle at five stars — because a
driver aiming at a car arrives alongside it, and one aiming beyond it carries
on into it.

### Cutting corners

Everything except a patrol car may leave the carriageway: cut a corner, put two
wheels on the verge, or take a line straight across open ground. A patrol car on
its beat keeps to the road, and that difference in how they move is part of how
you tell one from the other before the lights come on.

Allowing it is four changes, not one, because several separate things were
quietly holding units on the tarmac:

* **Lane keeping** is the term that stops a car cutting a corner, so a driver
  allowed off-road keeps only a quarter of it — enough not to wander.
* **Running out of road stops being a wall.** For these units it is a change of
  surface: the speed check brakes toward a pace the verge can hold rather than
  toward a stop — on the way *to* the verge, and only then (see below).
* **The direct-pursuit test no longer requires the line to be road.** Driving
  at the target across whatever lies between *is* the corner cutting.
* **"Get back on the road" became a rescue, not a rule** — it now fires only
  for a unit that has genuinely bogged down, not one that is deliberately
  taking a line.

They also get tyres for it. `offRoadGrip` applies only on the loose, so a
police car is no better on tarmac — it is simply less helpless the moment it
leaves it. Grass mu goes 0.62 to about 0.96. Before, a unit that cut a corner
crawled at 6–10 km/h on the other side, which is not a shortcut; it now carries
about 42 km/h off-road.

#### Slowing down for the corner, then taking it

*"When they're turning they slow down loads and then they turn. They need to
keep a relative good speed and cut the corner, like a human would."*

A unit follows its route by pure pursuit: aim at a point `look` metres ahead
and hold the arc that reaches it. `safeSpeed` then limits the speed to what
that arc's grip allows — and both the arc and the lookahead shrink as the car
slows. So a junction ran away with itself: the corner limit slowed the car, the
shorter lookahead tightened the arc, the tighter arc lowered the limit again,
and units arrived at every junction in the city doing 27 km/h. Measured, the
arc term was the binding constraint on **100%** of the samples where a unit was
under 50 km/h — the road's own geometry allowed 200 to 300 km/h at the same
moments.

Two things changed, both sized by measurement over one fixed route across the
city (`tests/corners.js`). A unit allowed to use the width of the road now
starts its turn 16 m back rather than 9, and the speed limiter will not believe
in a turn tighter than 13 m:

| junction minimum, km/h | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| before | 18 | 31 | 33 | 41 | 45 | 32 |
| **now** | **30** | **41** | **41** | **41** | **47** | **40** |

Every corner on the route is quicker and the slowest one by two thirds, with no
more scenery contacts than before. Tighter floors than 13 m were tried and are
worse, not better: at 21 m some junctions are taken at 53 km/h and others
collapse to 12 as the car runs wide and has to gather itself up, and by 26 m it
starts hitting things. Putting a floor under the lookahead as well changed
nothing measurable and is not in the game.

#### Flat out across a field

*"Is there any reason that when I go off-road, the police cars suddenly slow
down a lot?"* There was. The pace-for-the-verge check assumed a unit might have
to turn through a 45 m arc on grass, and slowed it to what the grass could hold
for that — about 75 km/h. That is right for a car *arriving* at the verge. But
the check works from how much road is left ahead, and once the car is out on
the grass there is none left in any direction, so the same figure became a
flat speed limit for as long as it stayed there: every unit held at 75 km/h
across open fields while you went across them at 190.

It now applies only while the car still has wheels on the road. With three on
the grass it stops, and the limits that remain are the ones that were always
there and already know they are on grass: how far it can see to stop in, on
the grass's own grip, and how fast it can take the turn it is actually making.

`tests/offroad.js` — the longest straight run of open grass on the city map,
490 m, you at 145 km/h, one unit forty metres back; and `tests/straightline.js`
on a grass plate with nothing on it at all:

| | before | now |
|---|---|---|
| on the map: unit's speed on the grass | 74–78 km/h | **135–138 km/h** |
| on the map: gap after 12 s (from 40 m) | 255–266 m | **54–65 m** |
| open grass plate, you at 190: gap after 20 s | ~500 m, and growing | **13–36 m** |
| crashes, either test | 0 | 0 |

### Not driving into buildings

Every clearance check before this answered "how hard must I brake", and braking
is not always the answer — a car that has run wide is going to touch the wall on
its outside whatever it does with the pedal, because the wall is not in front of
it. Units now cast a fan either side of the line of travel and steer toward
whichever side has more room.

Three details, each of which was a real bug found by measuring:

* **A wall dead ahead produced a bias of exactly zero.** Summing a push per ray
  gives the centre ray no side to push toward, so a building directly in front
  produced no avoidance at all and the car drove into it at 60 km/h. Measuring
  both flanks and steering to the roomier one fixes it.
* **The wide rays must not feed the braking clamp.** On any ordinary street
  there is a building about seven metres to either side; braking for those
  would reduce the whole force to a crawl everywhere. They steer, they do not
  slow. Only what is roughly in the way slows the car.
* **The rolling block was aiming into buildings.** It picked its aim point by
  extrapolating a straight line down the road's current tangent — fine on a
  straight, and on any bend it lands outside the curve, which is inside a
  building. Every scenery impact left in the pursuit was a blocker doing this,
  at 58–64 km/h with something solid at just about its own lead distance. It
  now follows the carriageway polyline.

The last-resort clamp inside `driveTo` is deliberately pessimistic where the
planners above are not: it fires only when the plan has already gone wrong,
which usually means the car is also turning and spending its friction on that,
so it assumes three quarters of the grip and keeps six metres in hand.

Scenery impacts per car-minute, measured over 150 s at four stars, counted as
step changes in speed with no other car nearby:

| | before | after |
|---|---|---|
| Ashfield | 0.44 | **0.07** |
| Wexbury | 0.49 | **0.03** |

### Getting back on the road

Two more failures put units on grass and kept them there, and neither was a
slide.

`_pursue` drove straight at the target whenever it had line of sight within
85 m. On a grid, a clear view of the car ahead usually does mean you are both
on the same street; on a town map of curving roads it means the line cuts the
bend, straight over whatever is inside it. Line of sight is now checked against
the surface as well as the geometry — a clear view over a field is not a road.

And nothing said what to do once off the carriageway. A unit shoved onto a
verge kept aiming at its lookahead point on the road it was no longer on and
ground along beside it at walking pace, sometimes for the rest of the chase.
Routes were never the problem: **not one planned waypoint was ever off-road** —
the cars had simply left them, a median of 25 m. Now, being off the hard
surface makes rejoining it the only job, aiming a little way *along* the road
rather than at the nearest point on it, because aiming at the nearest point
means driving at the kerb square on and sitting against it with the wheels
turned.

Measured over 90 s at four stars, same script both ways:

| | Ashfield before | after | Wexbury before | after |
|---|---|---|---|---|
| time on grass | 4.5% | **0.3%** | 25.5% | **12.4%** |
| more than 6 m off the carriageway | 15.7% | **7.9%** | 20.7% | **11.4%** |
| sideways past 26° | 0.5% | **0.3%** | 0.9% | **0.1%** |
| mean damage | 0.045 | **0.000** | 0.089 | **0.018** |
| median speed | 52.9 km/h | 51.7 | 42.9 km/h | **49.5** |

On the town map they end up both tidier and *faster*, because the time was
never being spent driving — it was being spent stuck on a verge.

### Backing out

A unit that has buried itself in something stops, selects reverse, backs out
with opposite lock so the nose swings toward where it wanted to go, and then
throws away its route — otherwise it drives straight back into whatever it just
left. It gives up early once it has made seven metres of room.

And then it stops going backwards. In reverse the pedals swap — the brake is
what drives the car backwards — and the speed control, which works on the size
of the speed, read a car still backing off faster than its target as "too
fast, brake" and sent it off backwards harder: a patrol car finished backing
away from a parked car at 26 km/h and was doing 29 and climbing ten metres
later. Still rolling backwards in reverse gear, the throttle is now always
what it gets — which stops it, and selects forward.

The detection has to work off the speed the *caller asked for*, not the speed
the safety limiter allowed. A car pinned against a wall is correctly told to
target zero, so testing the limited value means it is never considered stuck and
never reverses. That single confusion left reverse firing 0% of the time and
units stuck for over five seconds in 26% of samples.

### Lane keeping

Pure pursuit alone leaves a standing cross-track error through curves — the car
tracks a chord inside the bend rather than the lane. A Stanley-style correction
term pulls it back onto the line, scaled down with speed so it does not become a
twitch at motorway pace.

### One tactic at a time

A PIT and a rolling box are mutually exclusive across the whole pursuit. Boxing
units hold station relative to the target; a PIT car arriving across their line
wrecks both manoeuvres.

### Give way to the manoeuvre

A PIT or a box only works if the car running it can get to where it needs to
be, and in a pursuit of seven cars the main thing in its way is the pursuit.
Nothing used to say so: every unit treated every other unit as scenery to nudge
around, so a car authorised to strike had to thread the pack at whatever speed
the pack was doing.

A unit running a manoeuvre now carries right of way. Anyone who is not moves
off its line and eases back to let it through — short range, and only for a car
coming through from behind, because a unit two hundred metres back is not being
held up by anybody.

Mostly this is done with the throttle rather than the wheel, and that was
measured rather than assumed. A firm sideways push does let the manoeuvre car
past, at the cost of putting the rest of the pursuit on the verge: on the town
map the units well off the carriageway went from 5% of the chase to 15%. On a
street with a house either side there is nowhere to move *to*, and easing off
works there as well as it does on a dual carriageway.

### Closing a box

A box is called on units up to 55 m out and then has to form up, and for a long
time it could not: every unit was told to hold the target's speed plus 0.8 m/s,
which closes forty metres in fifty seconds — by which time the box has been
dropped for falling apart. So a crawling target simply collected two police
cars that sat beside it doing nothing. Three things were wrong, and the third
is the interesting one:

* **The speed.** A boxing unit now gets closing speed proportional to how far
  short of its slot it is, on a braking profile — fast from thirty metres, a
  walk over the last two, so it arrives rather than overshoots.
* **The aim.** Beyond 18 m from its slot it stops being a manoeuvre and goes
  back to being a chase, using the ordinary pursuit logic. That logic checks
  whether the line to the target is actually open and takes to the roads when
  it is not; driving straight at a point beside a car forty metres away was
  sending boxing units across gardens.
* **The direction.** Closing speed from the *distance* to the slot drives a car
  that has overshot faster and faster away from it, because going forward makes
  the distance bigger and the distance is all it is reading — a formed box came
  apart in three seconds with every unit flat out in the wrong direction. What
  speed can fix is the error *along the road*, measured in the target's frame,
  which is also heading-independent: a car knocked sideways in the scrum still
  knows which way its slot lies. Sideways error is the steering's job.

The pack also takes two cars off intercept duty when a box is genuinely on —
two units already in touch and the target down to walking pace. Without that
the third car was always away claiming a junction, and the box was never called
at all: there is nothing to get in front of at walking pace anyway.

Measured, 90 s at four stars: boxes called 0 → 3–4 a chase, and on a crawling
target the player is pinned and arrested. Three cars standing in their slots to
the centimetre stays rare, and that is fine — the box is for stopping you, not
for the formation.

### Why a PIT used to bounce off

The setup phase closes the gap and the strike phase turns in. Both were too
polite, in different ways.

The setup was allowed a flat 2 m/s of overspeed with a taper that had not begun
yet, so a car authorised from thirty metres back spent most of its twelve
second window barely gaining and timed out before it reached the strike window.
It now closes at a rate proportional to the gap, the way an ordinary pursuit
always has.

The strike was worse, and the cause is worth recording. It aims *through* the
target's far rear corner — a point three or four metres away and forty degrees
off the nose — and the driver's pure-pursuit grip limit reads that as a
four-metre-radius corner. So a 29 m/s strike was clamped to about 9 and the car
braked: measured, the unit arriving on the rear quarter exactly on the money,
then shedding half its speed and dropping sixteen metres back, every single
time. The strike is the one piece of driving that is *meant* to end in a
collision, so it now ignores the cornering limit for the second or so it lasts.
The last-resort clamp on anything solid straight ahead still applies — and the
ray it uses cannot see cars anyway.

| holding 22 m/s on a long straight | before | after |
|---|---|---|
| PITs authorised | 5 | 5 |
| reached the strike | 3 | 3 |
| speed held through the strike | 24 → 12 m/s | **24 m/s** |

Reaching the strike was never the problem. Carrying it through was.

### Roadblocks

From three stars, control starts putting cars across roads. Sites are not
picked at random — they come out of the same forward expansion of the road
graph the dispatcher uses to solve intercepts, so a block only ever goes in
somewhere you are actually heading, and driving unpredictably is a real defence
against them.

They go in **four to six seconds ahead of you**, not a fixed number of metres:
the window starts at 170–260 m and scales with your speed, out to 520–760 m.
A fixed window is a speed limit on the tactic — at 240 km/h, 260 m is under
four seconds away, and the block was going in behind a car that had already
gone past: *"the roadblock keeps on appearing behind me because I was going
really fast."* The same reasoning tightens the cone a site has to sit in: at a
crawl any road off the junction ahead is fair game, at 200 km/h there is
realistically one road you are going to be on, so sites off to the side are
dropped. Measured at 180 and 240 km/h, blocks now go in 172–193 m up the road
and 4.6–6.1 seconds ahead, on the road being driven. They are taken away once
you are 200 m past. Distance alone did not keep them
out of sight — on a straight road 160 m is plainly visible, and four cars and a
line of cones appearing there was the most obvious spawn in the game — so a
site is only used if the camera cannot see the middle of the block or either
end of it (see [Nobody appears in view](#nobody-appears-in-view)). The soonest
hidden site wins; if every site is in view, there is no block this time.

**The cars are real police units, not scenery.** They are parked across the
carriageway with the handbrake on, they take damage, they can be shunted, and
they stay where they are until one of two things happens: you get through the
block, or you give up and go back the way you came. Either way the block has
done its job, so they come off the handbrake and join the chase. Beating a
roadblock therefore costs you three more cars behind you — which is the price
of going round rather than turning back.

"Turned back" is deliberately not the same as "far away". A target that has not
reached the block yet is far away by definition, and a block that abandoned its
post on that basis would never be there when you arrived. It means a target who
was closing and has stopped: they got near enough to see it, and are now well
beyond that again, for a sustained couple of seconds.

How many cars depends on how much road there is to cover. Two cars on a
fifteen-metre street leave a five-metre gap straight up the middle, which is
not a roadblock, it is a chicane — so the block works out what one angled car
actually spans and puts down enough of them to close the carriageway, staggered
into two rows so that packing them edge to edge does not sit them inside each
other. A line of cones goes in 11 m up the approach, so the block reads before
you are in it.

They are also deliberately occasional: at least 34 s apart, longer after one
has been beaten, and never within 320 m of the last one. Set any shorter and a
block stops being a set piece and becomes weather — you round a corner, there
is a block, you go round it, and there is another one.

Measured at four stars on both maps: never more than two alive, going in at a
median of 157–198 m ahead and coming out at a median of 200–202 m behind. Held
for the full 90 s of a test where the target never came near; released on
`past` when the target drove through at 54 km/h, and on `turned back` after
21.6 s when it went elsewhere.

**Stingers.** Every roadblock now lays a stinger right across the road, kerb to
kerb, 19 m up the approach — further out than the cones, so a car that sees the
block late and threads a gap between the cars still goes over it. A wheel that
crosses it is punctured and goes down over about two seconds to a third of its
grip (`FLAT` in `vehicle.js`): still drivable, but slow to accelerate and
hopeless at speed in a corner. The tyre lights on the dashboard flash red, the
radio says so, and the garage fits new ones. Going round the block on the
pavement is the one way past it clean.

Each wheel's *path* over the frame is tested, not just where it is: at 200 km/h
on a slow frame a wheel travels two metres, and a strip 90 cm deep is easily
stepped over between two checks. Driven out past the map edge straight at a
stinger: all four tyres at 252 km/h at both 60 and 20 frames a second, and
at 144 km/h two when driven down its very end and none a metre clear. A jump in
wheel position larger than the car could have driven — flipping it upright,
a restart — is ignored, after that exact case punctured all four tyres of a car
teleported past a strip.

One bug worth recording, because it produced behaviour that looked like
anything but its cause: the road tangent runs from an edge's `a` end to its
`b` end, so a target arriving *at* the `a` end is travelling against it.
Getting that sign backwards pointed every car the wrong way down the road and
made the block read every approaching car as one that had already gone
through — so blocks dissolved on the frame they were built.

### The head-on van

An armoured van put on the road a quarter of a kilometre ahead, pointing back
down it, on your side of the white line, which then drives at you as hard as
three and a half tonnes will go. It does not brake for you, it does not steer
round you, and every other unit gives way to it.

It is rare and it is conditional, because a van aimed down a road you are about
to turn out of is just a parked van:

* **Four stars and up**, one at a time, thirty seconds between attempts.
* **Only on a road you are committed to.** The dispatcher tracks how long you
  have held a heading (`_trackCourse`) — a steady curve counts, a turn at a
  junction resets it — and wants three seconds of it plus 80 km/h.
* **Already doing 86 km/h when it appears** — three and a half tonnes takes
  its time, and the meeting is only seconds off.
* **Sited 190–400 m ahead**, aiming for about 260: far enough to build speed
  and to be seen coming, near enough that the meeting happens on this stretch
  of road. Out of sight if there is anywhere out of sight, and never closer
  than 260 m if there is not.
* **Genuinely nose to nose.** A site on a road crossing yours is rejected: the
  van's heading has to oppose your own, or it is a van parked across a side
  street rather than a van coming at you.

Getting there is by road, not as the crow flies. Measured first with the
straight-line version: the van left the carriageway the moment the road bent,
found a wall on a forecourt, and stopped 136 m short of the meeting. It now
follows the road toward you — routed to a junction 160 m *beyond* you, because
a path that ends where the meeting happens is one the driver slows down to
arrive at, and that version coasted into the contact at 20 km/h. Inside 70 m it
stops following the road and aims at where you will be.

`tests/rhino.js` drives the car down a long straight at 130 km/h and sends one:
placed 263–301 m ahead, pointing back at the car (facing −1.0 of a possible
−1.0), meeting it at up to **178 degrees** — dead ahead — and closing at
108–139 km/h. Contact is not guaranteed and is not meant to be: hold your line
and it hits you, move and it goes past. Afterwards it is an ordinary pursuit
unit again, a very heavy one, facing the wrong way.

It says so on the radio, going out and coming back: *"All units, van the wrong
way on Cold Harbour. Stand clear."* — then either *"Contact! Straight through
them."* or *"Missed them, turning round."*

### The rolling block

Distinct from an intercept, which races to a junction and waits. A rolling
block is a car put down on the road *in front of* you, pointing the same way
and already doing 18 m/s, whose whole job is to sit there and be slower than
you are.

How much slower depends on the gap: from a long way ahead it gives away a third
of your speed so the gap closes in seconds rather than half a minute, easing
back to just under your pace once you are on it — enough to hold the block, not
so little that it simply gets rammed off the road. It tracks the centreline of
whatever road it is on and matches your position across the carriageway, which
is what keeps it in front of you rather than politely alongside. Once you are
past it, or it has been left 14 m off to one side, it gives up the role and
rejoins the chase as an ordinary pursuer.

Three things about it took some finding, and all three are the same mistake in
different clothes — a unit that *is* the blocker being quietly treated as
though it were not:

* it was spawned into the roster after the frame's list of available units had
  already been taken, so the validation a few lines below decided it was not a
  real unit and dropped the block on the frame it was created;
* it gave up by returning pursuit controls while still holding the BLOCK role,
  so it came straight back in next frame and reported the block ended all over
  again — which held the dispatcher's cooldown open and stopped any further
  block ever being called;
* and because a car sitting on the road in front of you is one of the closest
  units there is, the pursuit loop drafted it straight back into the pack on
  the next role tick. Blocks lasted 0.2 s.

With those fixed, measured over 120 s at four stars on each map: eight blocks
called per run, **100% of them in front**, no spawn failures, at a median of
123–127 m. Blockers are the best-behaved cars on the road — **0%** of their
time is spent more than 6 m outside a carriageway, against 8–14% for ordinary
pursuers.

Every block ends the way it should: the give-up points recorded were the target
73 m past it, or 14–37 m off to one side. None ended for any other reason. A
block lives a median of 3.4–4.5 s against the test's harness driver, which
picks a fresh random destination every couple of hundred metres and so turns
off far more erratically than anyone actually fleeing; against a quarry
committed to a road the same code held blocks for a median of 12 s with half of
them turning into a sustained engagement. It is a tactic, not a wall — going
round it is meant to work, and costs you the time it takes.

### Getting busted

Drop below 3 km/h with a police car within 3 m of your bodywork and a five
second countdown starts, shown as a bar across the screen. Break contact or get
moving and it drains back at roughly twice the rate it filled, so shoving free
genuinely buys time rather than just pausing the clock.

**The police stay put while they arrest you.** *"When the police cars are
busting me, they should just stay still if they're near me, because otherwise
they just keep moving, and then it stops the busting."* They did: a unit that
had you pinned went on doing whatever its role said — backing out of the
contact, going round for another shove — which opened the gap and cancelled the
arrest it had started. Now any unit within 3 m of a stopped suspect, or within
5 m once the clock is running, sits on its brakes until you move off
(`Officer._holdingArrest`). Three cars driven in against a stopped car: all
three at a standstill within a second, and the arrest after exactly 5.0 s.

**And once it is over, everybody stops.** The radio has always said *"all
units, stand down"* at the arrest; behind the overlay the chase used to carry
on regardless — cars still driving at a car that is not going anywhere, boxes
still forming. Every unit now sits on its brakes the moment the outcome is
`busted`. Measured: seven units moving at the arrest, none a second later.

### Getting away

Getting arrested is an ending. Getting away is not, and it used to be: escaping
dropped the same full-screen curtain with *press R to run again* on it, so the
reward for a good escape was having the game taken away from you.

Now the heat clears, a banner says so for a few seconds and fades, and you are
still sitting in a car in the middle of a town. The force stands down: every
tactic is cancelled, every unit goes back on its beat at the posted limit, and
the shared model of where you are is thrown out — so a patrol that drives past
you a minute later has to notice you again from scratch, exactly as it would
have before any of it started. Drive badly in front of one and it will.

The roster comes back down with it. A five-star response is fifteen cars sent,
holding around eighteen on the board once the chase has collected a few, and an
ambient patrol is three, and nothing used to reduce that except the rule that
retires a unit 900 m away, so the town stayed full of police long after they
had stopped looking for you. Surplus units are now retired furthest-first, and
only once a car is far enough off or out of sight — the force thins out over
the next half minute rather than blinking out in front of you. **How hard that
bites scales with the excess**: one spare car is a straggler and gets the
patient treatment, five is a crowd, and the crowd goes quickly (160 m, or 70 m
and out of sight, up to every half second).

That matters because the board has a hard limit of eighteen vehicles, and a
long chase fills it: every roadblock you beat releases its crews into the
pursuit, and they are not counted when deciding whether to send more. Once the
limit is reached, nothing else can be built — including the next roadblock,
which gets called on the radio and then simply is not there: *"I couldn't see
half the roadblocks because there were too many police cars."* Four slots are
now held back from pursuit spawns for exactly that reason.

**How big the pack is allowed to be.** Trimming straight back to the number
the tier says to *send* left the chase looking thin — *"there's almost too few
units now"* — because a chase legitimately collects cars: the crews off every
roadblock you beat. So there are two ceilings. The tier budget governs how many
are dispatched; the pack may then keep what it has collected on top of that,
three cars' worth, up to a hard cap of **18**, and past that the car furthest
away drops off. It still never vanishes in view. Measured over a 90-second
five-star chase: **18.0 average, 18 peak**. Below five stars the ceiling comes
down with the wanted level, so dropping from five to three thins the pursuit
rather than keeping eighteen cars on a three-car call:

| wanted level | sent | ceiling on the board | measured, 60 s |
|---|---|---|---|
| 1 star | 2 | 5 | 2.0 |
| 3 stars | 7 | 10 | 6.7 |
| 5 stars | 15 | **18** | 12.7 rising to 18 |

Eighteen cars cost about twice the simulation of nine — 8.2 ms a frame against
3.9, out of the 16.7 ms a 60 fps frame has — so there is one more step on the
end of the graphics ladder: a machine still under 26 fps with shadows off and
the resolution reduced cuts the car limit too, and says so on the radio.

**A roster that never let go.** Underneath all of that was a one-line bug of my
own making: `retire` destroyed the car but never removed the officer from the
roster. The unit stayed on the books forever with no car under it — counted
against the budget so no replacement was sent, drawn on the minimap, and still
talking on the radio. It read exactly as reported: *"there were like 50
supposedly chasing me. I couldn't actually see them."* Over a 90-second
five-star chase, before and after the line went back in:

| | before | after |
|---|---|---|
| units on the board, peak | 19 | **12** |
| vehicles, peak (the limit is 18) | 18 | **13** |
| average over the nine-car budget | 10 | **0.1** |
| units with a destroyed car still listed | many | **0** |

**Callsigns are a pool, not a counter.** They used to count up forever, so a
chase that had been running a while was dispatching U47 and U51 — *"it will
start saying, unit fifty-one, going for a PIT"*. A number now goes back in the
pool when its car is retired, so the board reads U1 to U12 all night and a
callsign means "one of the cars out there" rather than "how many have ever
been out there".

Measured: five units at three stars, heat clear 68 s after they lose contact,
every remaining unit on patrol, and the roster back to the ambient count within
50 s — with the car still under your control throughout.

### Gearbox

Six ratios that change at roughly **55 / 83 / 109 / 137 / 153 km/h**, so no single
gear dominates the run up to speed.

Above half throttle the box selects by *tractive force* rather than by an rpm
threshold: it evaluates every ratio at the current wheel speed, discards any that
would hit the limiter, and takes whichever puts the most torque at the wheel. So
if you crash in sixth and floor it, the car drops straight to the right gear
instead of crawling back down one at a time:

| Stuck in 6th at | Gear after flooring it | Engine |
|---|---|---|
| 8 km/h | 1st | 1 440 rpm |
| 20 km/h | 1st | 3 360 rpm |
| 45 km/h | 1st | 6 420 rpm |
| 80 km/h | 3rd | 5 150 rpm |
| 120 km/h | 4th | 5 860 rpm |

Downshifts are judged against a lower rev ceiling than upshifts. That gap is the
hysteresis which stops the box hunting where two ratios score equally.

## How the police work

The interesting part is `src/ai/dispatcher.js`. It holds the only shared model of
where you are, and hands each unit a job:

* **Perception** — units need range *and* line of sight, and buildings block
  the line. Range is deliberately asymmetric: holding a car you are already
  following is easy (up to ~230 m), picking a specific car back out of a city
  you have lost it in is not (~105 m, and less again if you have slowed right
  down and are keeping your head down). A unit that is *searching* has no
  forward cone at all — it is scanning every direction, not staring out of the
  windscreen — and 20% more range than a plain reacquire. Break contact and the
  dispatcher dead-reckons for a couple of seconds, drives at your last known
  position for five, then searches for the rest of a **60 second** window —
  which is exactly the countdown on the HUD, and exactly how long you must stay
  hidden before the heat starts to fall.
* **Routing starts where the car is.** A route returns a path beginning at a
  graph *node*, which on a long curving A-road can be seventy metres away; a car
  handed that path drives straight at its first waypoint, and therefore straight
  across whatever lies between. Every path is prefixed with the remainder of the
  carriageway the car is actually on — and inside a junction, the car may also
  turn there. See [Missing the turn](#missing-the-turn).
* **Intercepts** — rather than driving at your current position, the dispatcher
  follows the road graph forward from you to the junctions you are *likely* to
  reach in the next ~25 seconds — at your speed, and learning your habits —
  then asks each free unit whether it can get there first. A unit that can is
  sent there and ignores you completely until it arrives. This is why the police
  appear *in front* of you. See [Guessing where you are going](#guessing-where-you-are-going).
* **PIT manoeuvre** — a real car steered into your rear quarter, only authorised
  between roughly 25 and 155 km/h. Tested in isolation: no spin at 58 km/h,
  reliable spins at 79 and 101 km/h, officer wrecks himself at 122.
* **Rolling box** — three units take lead / flank / trail slots and squeeze.
* **Rolling block** — from two stars, a car put down on the road in front of you
  and driven deliberately slowly. See [The rolling block](#the-rolling-block).
* **Roadblocks** — from three stars, cars parked across a road you are heading
  for. See [Roadblocks](#roadblocks).
* **Escalation** — five heat tiers change how many units respond, what cars they
  bring (patrol → interceptor → unmarked) and which tactics they may attempt.
  It is earned by being watched, and **the climb gets slower the higher it
  goes**, because one flat rate meant the top of the range arrived at the same
  pace as the bottom and five stars turned up while you were still working out
  what three meant (`tests/wanted.js`):

  | seconds in sight | 1→2 | 2→3 | 3→4 | 4→5 | total |
  |---|---|---|---|---|---|
  | steady | 80 | 105 | 135 | 170 | **8:10** |
  | over 137 km/h and drifting | 40 | 52.5 | 67.5 | 85 | **4:05** |

  Driving like the reason they are chasing you is a multiplier now rather than
  a flat addition — half again for the speed, a quarter again for a drift — so
  it shortens the top of the range in the same proportion as the bottom.
* **Contact counts once, and no longer counts against you.** Hitting a police
  car starts a chase if there is not one already (heat 1) and nudges the
  dispatcher's PIT cooldown, but it does **not** move the wanted level of a
  chase in progress. It used to add 0.28, a quarter of a tier a time — and a
  hit is not something only the driver being chased does. A police car ramming
  you put *your* wanted level up, and with a person driving that car, leaning
  on you is the whole game: *"it's a bit of a nightmare."* An impact also stays
  "recent" for 60 ms, and `Game._checkProvocation` used to count it on every
  frame inside that window — hundreds of times in headless tests, where
  `performance.now()` barely moves — so it remembers the last one it handled.

Police cars are **2.4–2.8× tougher** than yours, so they survive being shunted.
Once a unit is genuinely damaged it drops off the minimap, and it is removed from
the world as soon as it is more than 200 m away — far enough that you never see
one vanish.

Radio traffic names real streets, so you can hear the plan forming: *"U6,
cutting them off at Fifteenth Street and Meridian Avenue."*

### Evening it up

*"The Land Rover is a bit too fast. I think same with the really fast car ...
it's already relatively easy to lose the police just by going in between two
houses. Police cars still struggle to keep up, even on one to five. Just
increase their speed and grip a bit."* The levers are at the top of
`vehicles.js`, applied to whole groups of cars:

| | 0–100 before → after | top speed before → after |
|---|---|---|
| Stiletto (power ×0.85, shorter final drive) | 4.4 → **5.1 s** | 257 → **240 km/h** |
| Badger (power ×0.86) | 8.6 → **10.0 s** | 204 → **190 km/h** |
| Patrol | 7.0 → **6.4 s** | 215 → **230 km/h** |
| Interceptor | 6.5 → **5.9 s** | 222 → **241 km/h** |
| Unmarked | 6.0 → **5.5 s** | 222 → **247 km/h** |
| Police SUV | 8.2 → **7.5 s** | 218 → **230 km/h** |

The fleet has 12% more power, 8% more grip, and a taller sixth gear so the
extra power becomes top speed as well — before, every police car ran into its
limiter at 222 km/h however much help it had. Two more things turned out to
matter as much as the cars:

* **The drivers now plan on their own tyres.** A unit's corner speeds came from
  the road surface and its skill, and never from the car's own grip — so a car
  given more grip took every corner at exactly the same speed as before and
  simply had more in hand. `Driver._mu` now includes `gripScale`.
* **Less holding back at low wanted levels.** A unit's pace ran from 74% of
  what its car could do at one star to 100% at five; the floor is now 84%.

Measured with `tests/harness.js` — a driven quarry that brakes for corners, at
four stars with the police allowed contact — over the same three chases, old
settings against new, switched at runtime in the same page:

| | old | new |
|---|---|---|
| nearest unit, median | 60 m | **34 m** |
| time with a unit within 40 m | 39% | **56%** |
| police well off the road | 8% | **6%** |

Better in all three, including one where the quarry was driving faster than in
any other run. The kinematic tail test (`tests/tail.js`, a car moved at a
constant 100 km/h that never slows for a corner) was too noisy to call either
way — a car that takes right angles at 100 km/h is not one the police should be
able to follow round them anyway.

### Missing the turn

"Have the police got slower and worse at routing?" They had. `tests/response.js`
puts one patrol car on a quiet map and sends it to a junction 400–650 m away,
twelve fixed trips chosen by map position so every version of the game drives
the same ones, and times it. Run against older commits, the city trips took:

| version | arrived | total time |
|---|---|---|
| before raised kerbs | 12 of 12 | 592 s |
| raised kerbs | 12 of 12 | 649 s |
| crossings stitched into the motorway, and every commit since | 11 of 12 | 648 s |

Nothing after that changed the driving at all — the numbers were identical to
the tenth of a second through every later commit. Tracing the slow trips showed
the same thing each time. A unit re-plans its route every second or so, and a
new route starts at the junction *ahead* of the car — correct everywhere except
inside a junction, where the nearest road is as often the one straight on as the
one the car came in on. So a car slowing into its turn got a fresh route that
began a block further on, and went straight across. One trip missed four turns
in a row that way and never arrived. The kerbs made it common — a car corners
slower over them and spends longer in the junction — and stitching the crossings
added junctions for it to happen at.

`RoadGraph._turnHere` now asks, when the car is inside a junction, for a route
that turns off there too, and takes it if it is at least two seconds quicker. It
only offers turns the car can make: one it is already swinging into, or any turn
short of a U-turn below 47 km/h.

| | arrived | total time | average speed | stuck |
|---|---|---|---|---|
| city, the twelve trips, before | 11 of 12 | 648 s | — | 16 s |
| city, the twelve trips, after | **12 of 12** | **579 s** | — | 26 s |
| city, twenty other trips, before | 20 of 20 | 1004 s | 59 km/h | 50 s |
| city, twenty other trips, after | 20 of 20 | **851 s** | **70 km/h** | **17 s** |
| Wexbury, sixteen trips, before | 14 of 16 | 759 s | 66 km/h | 38 s |
| Wexbury, sixteen trips, after | **15 of 16** | **713 s** | 67 km/h | 67 s |

On the twenty city trips not one got slower; the worst were 80 s → 37 s and
89 s → 55 s. They also leave the carriageway less (5.8% of the time → 1.1%): the
wide sweeps across the pavement were mostly missed turns being recovered.
Wexbury's stuck time is one trip wedged on the same spot in both versions.

Two other fixes were tried and measured worse, and are not in: refusing to plan
a U-turn at the junction ahead (going round the block is a longer route with
more turns to miss — 12 of 12 trips became 9), and stopping the path follower
jumping onto the return leg of a route that doubles back (a real bug, but every
version of the fix cost more elsewhere than it saved — 10 of 12).

What this does not change is pursuit with the car in sight, which is not routed
at all — a unit with a clear line drives straight at you across whatever ground
is there. `tests/tail.js` moves the player's car along a fixed route at a fixed
speed that nothing can slow down and measures how closely the police stay with
it; on both routes measured it came out identical before and after this change.
Across older versions it moves about with the route — on one, the first unit
reached the car ten seconds later once spawns had to be out of sight, on the
other there was no difference — and two runs are not enough to say more than
that.

### Nobody appears in view

Every police car the game creates — joining the roster, put in front of you as a
rolling block, parked across a road as a roadblock — is placed only where the
camera cannot see it. `Game.inView` asks three things of a spot: is it inside
the camera's view (with a margin that grows with distance, since half a car
coming into shot is still a car appearing), is it within 700 m (beyond that it
is lost in the fog), and is there a clear line from the camera to it (a building
in the way hides it). A spot that passes all three is rejected and the next
candidate tried.

Before this, rolling blocks and roadblocks relied on distance alone and popped
into existence 140–160 m up the road. `tests/popin.js` drives a two-minute
four-star chase through the city and checks every police car at the moment it is
created: before, 7 of 20 were created in plain view; after, 0 of 16. Rolling
blocks still get placed — a failed attempt now looks again after 3 s rather
than waiting out the 14 s cooldown, since the next corner usually hides one.

### Guessing where you are going

*"Make the interceptors better at predicting where I am going to go."* The
intercept solver used to ask `RoadGraph.reachable` where the car *could* be in
the next 24 seconds, which has two blind spots for this job. Every junction was
as likely as every other, so units were spread over side streets the car was
never going to take. And every road was assumed to be driven at its limit, so
at 160 km/h the car was through a junction before the unit sent to it arrived.

`RoadGraph.predict` follows the car's likely choices instead:

* **Probability.** Each junction splits the chance between the ways on:
  straight on far more often than not, onto a road at least as big as the
  current one in preference to a smaller one, a dead end or doubling back only
  rarely. Junctions are then ranked by how likely the car is to come through
  them, times whether the timing is worth driving for.
* **The car's own speed**, where that is faster than the road's — less what a
  turn would cost it: braking to a speed the corner allows and getting back up
  again, which at motorway speed is several seconds and a large part of why a
  fast driver goes straight on.
* **Learning.** The dispatcher watches the heading going into and coming out of
  every junction it sees you take, and keeps a running share of how often you
  go straight on (`straightShare`, weighted to the last five or so). Throw the
  car down every side road and the intercepts spread across the side roads;
  stay on the main road and they wait on it.

Each unit then takes the junction with the best mix of likelihood and a
comfortable arrival margin, rather than simply the best margin.

`tests/intercept.js` measures it: the car is moved along a fixed route — the
same in every version — braking for corners the way a driver would, with four
stars held and contact forced, on three routes at 90 and at 160 km/h, two
minutes each:

| | old solver | new, 8% cut-off | **new, 3% cut-off** |
|---|---|---|---|
| junctions where a unit was already waiting | 7.8% | 12.1% | **12.7%** |
| intercept orders the car did then drive through | 8.9% | 34% | **19%** |
| seconds of *correct* intercept, all runs | 68 | 68 | **117** |

The 8% cut-off was right most often but sent so few cars that no more
intercepts came off; 3% is still twice as accurate as the old solver and makes
most of them count. Runs vary a lot — one collision changes the rest of a chase
— so these are totals across all six rather than any single run.

The catch-up assistance was checked and left alone on request. For the record,
because it is easy to misremember: yellow on the minimap is a unit on
intercept, which is routing and nothing else; the physics help (more power,
more grip, a stability aid, no damage on the way in) applies only to a unit
*more* than 30 m away and is gone by the time it is close enough to touch you.

## The cars you can run in

Picked on the menu, above the maps, and remembered between visits. Pressing
**M** in game goes back to change it.

**The Runner** is the car the whole game was tuned around: a quick rear-drive
saloon that is tough enough to lean on the police with. **The Stiletto** is
the other way to run — a mid-engined V12 supercar, and the trade is meant to be
real: much faster, much stickier, and the car you had better not let them touch.

`tests/supercar.js` measures both on flat tarmac out past the edge of the map,
with the surface forced to road, so neither is measured against a bend, a tree
or a verge — only against the other car. These are the figures on the menu:

| | Runner | Stiletto |
|---|---|---|
| 0–100 km/h | 7.37 s | **5.0 s** |
| 0–160 km/h | 15.3 s | **8.23 s** |
| 0–200 km/h | 28.0 s | **12.2 s** |
| top speed | 215 km/h, on the limiter in 6th | **240 km/h**, on the limiter in 7th |
| peak steady grip, 60 km/h | 1.28 g | **1.50 g** |
| peak steady grip, 120 km/h | 1.40 g | **1.58 g** |
| peak steady grip, 170 km/h | cannot hold the speed | **1.64 g** |
| braking from 100 km/h | 31.8 m | **27.0 m** |
| damage from one 50 km/h shunt | 8.5% | **20%** |
| shunts until the engine starts to fade | 4 | **2** |
| shunts to a wreck | 11 | **5** |

The shunt used to start sixty metres short of the parked car and coast in, so
engine braking decided how hard it hit — detuning the Stiletto's engine moved
its figure from five hits to four without the car being any less tough. It now
starts ten metres short and arrives at the speed it says.

**Not too fast to catch.** As first built the Stiletto did 0–200 in 9.7 s and
303 km/h. Every police car tops out at 222 km/h, rubber band or not — the
rubber band adds torque and cuts drag, but it cannot take a car past its own
limiter — and the helicopter at 223. So at five stars you could simply drive
away from everything on the first long straight: *"even on wanted level five,
I can easily escape the police, even the helicopter."* The torque curve is down
18% and the final drive shortened to match, so it still reaches seventh and
still pulls hardest at the top (`tests/outrun.js`):

| | 0–100 | 0–200 | top speed |
|---|---|---|---|
| Runner | 7.4 s | 28.0 s | 215 km/h |
| Stiletto, as built | 3.7 s | 9.8 s | 304 km/h |
| **Stiletto, now** | **4.4 s** | **12.2 s** | **257 km/h** |
| Unmarked, rubber band at full stretch | 5.2 s | 11.1 s | 222 km/h |
| Interceptor, rubber band at full stretch | 5.5 s | 12.1 s | 222 km/h |

Still far quicker than the Runner and still faster than the fleet flat out, but
a pursuit car closing on the rubber band can live with it, and the helicopter
can now outfly it (see Air support).

Grip rises with speed on the Stiletto and not on the Runner: that is 0.60 m²
of downforce against 0.42. And every police car still out-brakes both, because
they keep the anti-lock system neither player car has.

**How it gets there.** A V12 that revs to 8 800 on seven close ratios and a
twin-clutch box that changes in 0.06 s; 58% of the weight over the rear wheels
and less yaw inertia than a saloon, which is what makes it turn in; wider
tyres, more grip at both ends, and short, stiff suspension. The fragility is
one number — `durability` 1.4 against 3.2 — which also means the torque falloff
past 28% damage arrives after two hits instead of four.

**Launch control, and why it was needed.** The first build only did 0–100 in
4.3 s, and the rear tyres were never the limit — slip ratio never passed 0.06.
The engine model locks rpm to the driven wheels whenever the clutch is in, so
from a standstill it sat at 1 000 rpm making idle torque for the first second
of every start, at 0.6 g, on tyres with twice that to give. An optional
`engine.launchRpm` now lets the clutch slip and hold the engine up in first on
a big throttle, the way a twin-clutch launch does. Only the Stiletto has it:
the Runner's 0–100 is unchanged.

**It hates kerbs, and does not get hurt by them.** With 160 mm of travel, a
kerb at 26 m/s takes the suspension to the bump stop and throws the body up
71 mm (the Runner: 185 mm of its 200, and 34 mm). Still no damage and no speed
lost from the kerb itself — a bump stop is a vertical spike, and the collision
damage rule only reads a large velocity change, so it was worth measuring.

**Staying on its line.** `tests/handling.js` reads balance from yaw rate times
speed, which is the right number while a car is on its line and the wrong one
once the tail starts to come round — it reports the rotation as grip, and on
this car it produced lateral figures of over 2 g. `tests/stability.js` asks the
plainer question instead: hold a speed and a steering input, and see how far
the body ends up from the direction of travel. At half lock and 90 km/h, with
throttle holding the speed, the Runner spins and the Stiletto holds 1.3° of
body slip at 1.34 g.

### The Badger

The third way to run: a square-rigged old 4x4. Slow on the road, heavy in the
corners, and the toughest thing you can drive — four-wheel drive, long springs
that do not notice kerbs, and tyres that grip on grass nearly as well as on
tarmac (grass comes up from 0.62 to about 1.1, against the Stiletto's 0.74), so
the shortcut across the park that bogs everyone else down is yours.

| | Runner | Stiletto | **Badger** |
|---|---|---|---|
| 0–100 km/h | 7.4 s | 5.1 s | **10.2 s** |
| top speed | 215 km/h | 240 km/h | **142 km/h** |
| peak steady grip, 120 km/h | 1.40 g | 1.58 g | **1.08 g** |
| shunts to a wreck | 11 | 5 | **19** |

It used to run to 190, which made it a chase nobody could finish: the fleet
tops out around 185–222 and spends most of a pursuit well below that, so a
four-wheel drive that could sit at 190 on a dual carriageway simply left. Now
it is geared like a working off-roader — five short ratios and a brick's worth
of drag — and runs out of revs in top at **142 km/h**. Nothing else about it
changed: same grip, same armour, same 0–100 to within a tenth, and the same
advantage the moment the tarmac stops.

The body is lofted the same way as the police SUV and van (`bodies.js`): flat
panels, an upright screen, a raised waist behind the bonnet, a cream roof, wide
black arch flares over big tyres, a bull bar, round lamps, a roof rack with a
pair of spotlights, a snorkel and the spare wheel on the back door. First built
it did 9.5 s to 100 and took 23 shunts to wreck — more than twice the Runner —
so it got 10% more engine and slightly less armour. It sits high, so like the
SUV it takes cornering force in above the road, and it does not lift a wheel
at full lock at any speed.

### Grip at speed

Both cars slid too much at speed, and the cause was not what it looked like.
More downforce — two and a half times as much — barely changed anything. The
road tyre only reaches its peak cornering force at **8.6° of slip**, so a car
cornering hard at 140 km/h sits nine or ten degrees sideways even while it is
gripping perfectly well, and that reads as a slide.

So both player cars carry a `highSpeedTyre` in their spec: from 72 km/h, fully
by 150, the lateral curve stiffens (the limit arrives at a smaller slip angle,
so the car points where it is going) and grip rises a little. Below 72 km/h
nothing changes, so a handbrake turn is still yours. It had to be weighted to
the rear — on the Stiletto, with 58% of its weight at the back, stiffening or
adding grip evenly made the nose bite harder than the tail could follow, and it
spun at 140 km/h in every even configuration tried.

Full lock held for two seconds, throttle holding the speed — body slip, mean and
worst:

| | before | after |
|---|---|---|
| Runner, 140 km/h | 11.2° / 17.4° | **1.6° / 3.3°** |
| Runner, 180 km/h | 10.5° / 15.5° | **1.0° / 2.2°** |
| Stiletto, 140 km/h | 7.4° / 12.6° | **1.7° / 6.0°** |
| Stiletto, 180 km/h | 9.1° / 17.1° | **1.1° / 3.6°** |

Peak steady cornering grip (`tests/gripsweep.js`): the Runner is unchanged at
60 km/h (1.28 g) and goes from 1.29 g to 1.40 g at 120 and 1.50 g at 170; the
Stiletto is unchanged at 60 km/h (1.51 g) and goes from 1.58 g to 1.89 g at 120
and 1.62 g to 2.02 g at 170. The police cars do not have it.

#### Too much, on the Stiletto

*"The really fast car seems to have too much grip, especially at high speeds.
You can steer full lock and it will still remain stable."* It could. Its
high-speed grip had been weighted so hard to the rear — ×1.40 grip and ×2.4
stiffness at the back against ×1.16 and ×1.4 at the front — that the tail could
never let go. Held at full lock at any speed, the front tyres gave up first and
the car simply ran wide at up to 2 g with the body pointing dead straight:
under a degree of slip. A keyboard is always at full lock when it steers, so
that was every high-speed corner.

Now the fronts are only a little stiffer and grippier than the rears at speed
(×1.2 and ×1.05 stiffness, ×1.05 and ×0.97 grip), downforce is 0.60 m² instead
of 0.95, and overall grip is down a touch (`gripScale` 1.18 → 1.12). Held at
full lock above about 140 km/h the tail comes round and the car sheds speed;
let go and it is straight again within a fraction of a second. It does not spin
and it does not lift a wheel (`tests/rollover.js`), and below about 130 km/h it
is still planted — under 3° of slip at full lock.

Full lock held for two seconds, throttle holding the speed (`tests/highspeed.js`):

| Stiletto | before | after |
|---|---|---|
| 140 km/h | 0.3° / 0.9° slip, 1.61 g | **3.3° / 7.0°, 1.41 g** |
| 180 km/h | 0.4° / 0.8°, 1.80 g, down to 166 km/h | **6.9° / 14.2°, 1.43 g, down to 155** |
| 220 km/h | 0.6° / 1.2°, 1.96 g | **8.3° / 15.4°, 1.46 g** |
| 180 km/h, off the throttle | 0.6° / 0.9°, 2.03 g | **10.2° / 17.0°, 1.52 g** |
| steady grip, 60 / 120 / 170 km/h | 1.57 / 1.77 / 1.91 g | **1.50 / 1.58 / 1.64 g** |

Still the grippiest thing on the road — the Runner does 1.28 / 1.40 / 1.50 g —
and acceleration and top speed are unchanged.

### Keeping the Stiletto on its wheels

That extra grip put the Stiletto on its roof. The Stiletto figures above were
partly measured on a car already rolling: `tests/rollover.js` holds full lock
from a straight line, slaloms, and slides the car sideways into a 14 cm kerb,
and with that tuning the Stiletto went over on full lock at every speed from
100 km/h up, and in a 160 km/h slalom. The Runner never did.

The cause was where cornering force went into the car. Each tyre's sideways
force was applied at the contact patch, on the road, half a metre below the
centre of mass. On a real car the suspension links carry that force into the
body at the *roll centre*, well above the road, and only the height from there
to the centre of mass tries to roll it. Applied at the road, the Stiletto's
tipping point worked out at about 1.7 g, and at speed its tyres could do 2. Its
inside wheels were already lifting on full lock at 60 km/h, before the
high-speed grip existed; the grip only pushed it the rest of the way.

So a car's suspension now has a `rollCentre`, the height at which cornering
force enters the body. It is 0 — the road, unchanged — for every car except the
Stiletto, which has 18 cm. Longitudinal force still goes in at the road, where
dive under braking and squat under power come from.

| Stiletto | before | after |
|---|---|---|
| full lock, 100–220 km/h | **rolled over** every time | 1.7–2.2° of roll, all four wheels down |
| slalom, 80–200 km/h | rolled at 160; a wheel in the air for up to 3 s | 1.6–2.3°, all four wheels down |
| sideways into a kerb at 90 km/h | 5.0–5.4°, a wheel up for 0.15 s | 4.7–5.1°, 0.1 s |
| full lock at 130 km/h (`tests/stability.js`) | ended on its roof at 47 km/h | 1.80 g, 0.4° of slip, held |
| steady grip at 60 / 120 / 170 km/h | 1.51 / 1.89 / 2.02 g | 1.57 / 1.77 / 1.91 g |

The old 2.02 g at 170 km/h was being reached on two wheels. Full lock held at
speed (`tests/highspeed.js`) now gives 1.62–1.66 g at under 1° of slip, where
before it gave 0.7–1.0 g because the car was on its way over.

### The bodywork

The saloons are mostly flat panels, which tapered boxes suit. This car is all
curves along its length — a nose that rises into the wings, a roof that falls
away into the engine cover, haunches that swell over the rear wheels — and
stacking boxes to fake that gives a car made of steps. So it is lofted:
`MeshBuilder.addLoft` skins a series of cross-sections, mirrored about the
centreline, with a colour per edge and per run so one loft carries screen,
roof, buttresses and engine cover.

Two things were wrong in the first version and are worth recording:

* **Arches cut as notches.** Two sections a millimetre apart make a vertical
  step, which is a fine way to open an arch and a bad one to shape it: a square
  cut-out the length of the opening read as a black box round every wheel. The
  underside now follows a circle about the hub, 60 mm clear of the tyre.
* **One dark core the length of the car**, to stop you seeing through the
  arches, stood up through the bonnet near the nose where the bodywork is
  lower. One per arch, no taller than the underside over the wheel.

Winding comes from construction rather than from guessing which way is out: a
heuristic about the loft's axis gets the steeply raked faces of a nose wrong,
and a wrongly wound face on a single-sided material is simply a hole.

The body is placed on the axles, not centred on the centre of mass — with 58%
of the weight at the back, a body centred on it would have had a stubby nose
and a tail a metre and a half long — so the collider takes a matching
`colliderZ`. Wheels are instanced from one tyre and scaled per car, with wider
rears on this one. The engine note fires six times a revolution rather than
four, and the recording underneath it is pitched to match.

## Bringing in a model

Every car here is generated geometry, and does not have to be. Drop a `.glb`
into `resources/models` and it replaces the body of one kind of car —
`police-suv.glb` takes the police SUV; other kinds are a line in `CAR_MODELS`
(`src/game/carmodel.js`). With no file there, nothing changes, which is the
normal case: a missing model is not an error.

What stays the game's, whatever the file contains:

* **The collider**, always `spec.dims` for that kind of car. The model is
  fitted to it, not the other way round, so the thing you see and the thing you
  hit are the same size.
* **The wheels** — one shared instanced mesh the physics spins and steers, so
  any wheels in the file (anything named `wheel`, `tyre`, `rim`…) are dropped.
* **The flashing lights**, instanced boxes placed each frame at body-local
  offsets. The model can keep its own light bar as unlit plastic and the
  flashers sit on top of it.

**Fitting is done by the model's own wheels.** The game knows exactly where it
will put this car's wheels — the spec's wheelbase and weight split fix the
axles, and the suspension's static sag fixes the height (`wheelLayout`, which
agrees with a car parked in the game to a centimetre). So a model that comes
with four wheels is scaled until its wheelbase is the game's, slid until its
axles are the game's, and stood on its own tyres; then its wheels are thrown
away, and the game's land exactly in the arches the modeller cut.

The first fit matched the old generated body's bounding box instead, lining up
lowest points. That happened to look right on the SUV and was plainly wrong on
the patrol car, whose sills ended up two centimetres off the road with the
wheels half-buried in the flanks. By its wheels, the patrol car comes out at a
scale of exactly 1.00 and 4.92 m long — the modeller hit the brief — with the
sills 24 cm up. A model with no wheels in it still falls back to the box fit:
right size, right place, arches not guaranteed. What neither can infer is a car
modelled facing backwards — that is `yaw` in the table — or a light bar in an
unusual place, which is `lamps`.

The awkward one is livery (your SUV has its markings baked in already, which is
exactly right). Marked cars are painted from a texture atlas keyed to
UVs the geometry builder generates, and an imported model arrives with its own,
so its markings have to be baked into its own texture. There is a per-car cost
argument too: at five stars there may be eighteen police cars on screen and they
are all this model, so one material and 5–15k triangles is the budget. See
`resources/models/README.md`, and `tests/carmodel.js` for the fitting test.

## Police livery

Marked cars carry a full modern British livery, and like everything else in the
project it is generated at runtime rather than shipped as an image. `livery.js`
paints one 1024 × 1024 canvas holding five panels and uploads it once:

| Panel | Where it goes |
|---|---|
| Battenburg the length of the car, with **POLICE** on a plate in the middle | both flanks, nose to tail |
| **POLICE** reversed | bonnet — so it reads in the mirror of the car in front, which is the whole reason forces do it |
| Red and yellow chevrons | tailgate |
| Unit number | roof |
| Battenburg with **POLICE** over it, door-sized | the armoured van, above the windscreen |

*"What I really want is some good-looking police cars."* The battenburg used to
cover one door, the light bar was a slim strip, and the push bar hid the
headlamps. Now the checks run the whole flank, the light bar is full-width with
seven lens modules and clear end caps, and every flashing lamp has a soft halo
round it (additive points in `LightBars`, one draw per colour however many
cars), which is what makes a lit lamp read as a light rather than a coloured
brick on the roof. The kit — bar, battenburg, chevrons, roof number, push bar
and strobes — is one function, `addPoliceKit` in `bodies.js`, laid out from a
handful of measurements of whichever body it is going on, so every police
vehicle wears it the same way and the flashers follow its bar.

The bodywork stays vertex-coloured and the decals are textured quads; both live
in one geometry with a material group each, so a police vehicle is two draw
calls rather than a separate mesh per marking.

### The fleet

| | from | 0–100 | top speed | grip | hits to wreck | |
|---|---|---|---|---|---|---|
| Patrol | 0 stars, **gone at 4** | 6.4 s | 230 km/h | — | — | the saloon everything starts with |
| **SUV** | 2 stars | 7.5 s | 230 km/h | 1.25 g | 17 | tall, heavy, four-wheel drive, best on grass |
| Interceptor | 3 stars | 5.9 s | 241 km/h | — | — | more engine than the patrol car |
| Unmarked | — | 5.5 s | 247 km/h | — | — | the quickest thing they have; not currently fielded |
| **Armoured van** | 5 stars | 10.5 s | 167 km/h | 0.96 g | 67 | one at a time, rarely, and there to be in the way |

**Four stars and up is interceptors and SUVs** — about 55/45 in pursuit and
45/55 on roadblocks, where the wider SUV makes the better wall — with the
occasional van at five. *"When it gets to wanted level four and five, can you
make it so patrol cars stop spawning... just interceptor cars and SUVs."* Patrol
cars still out when the heat rises are stood down one at a time, furthest first
and only where you cannot see it happen, and the gap each leaves is filled from
the higher tiers. Measured, a two-star chase of five patrol cars and one SUV was,
fifteen seconds after going to five stars, seven SUVs, five interceptors, a van
and two patrol cars — the two that stayed were close behind the car the whole
time, where standing them down would have been visible.

The SUV and the van are new bodies (`bodies.js`), built like the Stiletto from
lofted cross-sections with round wheel arches rather than stacked boxes, with
heights worked out above the ground: a tall vehicle on long springs sits a very
different distance above its centre of mass than a saloon does. The SUV is a
square-shouldered modern 4x4 with the band along its doors above the arches;
the van is a high-roofed panel van with mesh over the windscreen, barred
windows, a second light bar facing backwards and a blue stripe along the box.
Both take cornering force in above the road (`rollCentre`), and neither lifts a
wheel at full lock or in a slalom at any speed in `tests/rollover.js`. SUVs make
up about a quarter of the cars at two stars and more above, and stand in
roadblocks from three; the van is one car in seven at five stars, never two.

## Sound

Everything is synthesised with WebAudio except the engine, which is a recorded
loop with a synthesised layer underneath it.

### The engine

The supplied recording (`resources/sounds/freesound_community-engine-61234.mp3`)
was analysed before being used, and it turned out to be 31.75 s of **steady
idle** — a constant 50 Hz fundamental with no rev sweep anywhere in it. That
rules out the usual approach of slicing a recording into rev bands and
crossfading between them: there are no bands to slice. So it is used the only
way a single steady loop can be, pitch-shifted, with two things done to stop
that sounding like a tape being spooled:

* **Compressed pitch mapping.** Playback rate follows `(rpm / 750) ^ 0.62`
  rather than the literal ratio, so 750–7000 rpm maps to 1.08×–3.96× instead of
  1×–9.3×. A literal mapping is correct and sounds absurd — chipmunk at the top
  end — because pitching a recording up drags its formants and its noise floor
  up with it.
* **A synthesised sub underneath**, which does run at the true firing
  frequency. The loop supplies the texture and the sub supplies the weight, so
  the note keeps its bottom end at high revs even though the sample has been
  pitched well above where it was recorded.

The loop points are chosen inside the steady middle of the file and crossfaded
— material from past the loop end is faded back over its start — so there is no
click at the seam.

Underneath, and on its own if the sample fails to load, is the synthesised
engine. Three plain oscillators through a lowpass sound like a synth drone. A real
exhaust is a train of pressure pulses pushed through a resonant pipe, so the
engine is built the same way:

* a custom `PeriodicWave` whose harmonic series is shaped like an exhaust pulse
  — gentle rolloff with the odd harmonics favoured — rather than a sawtooth,
* a **half-order sub**, the weight a big V8 gets from firing unevenly across its
  two banks,
* **two banks a few cents apart**, beating against each other so the note has a
  lump in it instead of being a dead steady tone,
* a **waveshaper** path crossfaded in with throttle, because an engine under
  load is not merely louder, it is dirtier,
* a **resonant peak tracking the firing frequency**, standing in for the pipe,
* a slow burble on the level at idle that dies away as the revs rise.

Everything is locked to the firing frequency (`rpm / 60 × cylinders / 2`), so
the whole note moves as one. Measured by rendering the graph offline and
analysing the spectrum:

| rpm | throttle | peak | centroid | energy below 160 Hz |
|---|---|---|---|---|
| 850 | idle | 29 Hz | 107 Hz | **79%** |
| 2000 | 0.5 | 269 Hz | 258 Hz | 56% |
| 3500 | 0.8 | 232 Hz | 297 Hz | 45% |
| 5200 | 1.0 | 172 Hz | 434 Hz | 12% |
| 6900 | 1.0 | 232 Hz | 833 Hz | 8% |

Deep and dominated by low frequencies at idle; the centroid climbs steadily with
revs as the filter and the waveshaper open up. Every peak lands on a real
component of the note — the sub, the firing frequency, or its second harmonic.

### Tyre scrub

The squeal layer only starts once a wheel is properly sliding -- past 0.45 of
saturation -- which is a drift or a locked brake, not a corner. A tyre
complains long before that, as soon as it is asked to carry a slip angle, so
scrub has its own voice: lower and broader than the squeal, a growl rather than
a shriek, driven by the worst lateral slip angle any grounded wheel is holding
and scaled by speed. The two layer rather than compete.

Measured through a steering sweep at a steady 60 km/h:

| steering | worst slip | scrub | slide |
|---|---|---|---|
| 0.15 | 0.8 deg | silent | silent |
| 0.35 | 2.4 deg | just audible | silent |
| 0.60 | 5.7 deg | rising | starting |
| 1.00 | 15.1 deg | full | full |

### The police radio

Every line that reaches the HUD also goes out over the net. `Game.radio` is the
single choke point for every call site, so the audio hangs off that and the two
can never drift apart.

**The voice actually speaks.** It used to be synthesised: a buzz through two
formant filters, stepped to a different vowel once a syllable, meant to read as
speech without ever saying anything. It did not read as speech — the verdict
was *"it just makes a really weird noise, it's not even speech"* — and that is
fair: nonsense syllables are uncanny in exactly the way a real voice is not.
So the line is now read out by the browser's own speech engine, rewritten
first into something a person would say (`speakable`): "U3" becomes "Unit 3",
"PIT" is a word rather than three letters, a slash between two roads is "and",
and dashes are pauses.

Voices are chosen from whatever the machine has (`pickVoices`): English only,
British first, local voices ahead of ordinary network ones — a network voice
can lag behind the HUD or not arrive at all offline. Control is a female voice
where there is one, units a male one, air support a third; on this machine that
is Hazel, George and Susan. With no English voice at all, a call is just the
key going down and coming up again.

**Picking a different voice.** Windows has one British man, George, and he is
the quiet one (see "The engine sits under the radio"): even after the mix was
ducked hard under him, *"I still can't hear them very well."* No game can make a
speech voice louder than full volume, so the menu now has a **Radio voices**
row under the maps: Control, Units and Air support each get a list of every
English voice the browser has, with a play button, and choosing one reads out a
sample line at the rate and pitch that speaker uses in a chase. The choice is
remembered, and a voice that has since gone from the machine falls back to the
automatic pick. Which voices are on the list is down to the browser: Chrome and
Vivaldi on Windows show the Windows voices, and more can be added under
*Settings › Time & language › Speech*; Edge also has Microsoft's natural
voices — Ryan and Thomas among the men — which are both louder and far clearer.
Those are now picked automatically when they are there, ahead of the local
voices, since the reason for preferring local voices was a line arriving late
and a natural voice starts quickly enough.

The speech engine plays outside Web Audio, so it cannot go through the radio
channel's filters. What makes it sound like a radio is everything around it:
the PTT click before, a faint open-carrier hiss underneath (and the rotor for
India 99), and the squelch crash after. The channel is held for as long as the
engine is actually speaking — nobody can know in advance how long a line takes
to say — with a timeout in case an engine never reports the end.

Three things had to be measured rather than guessed:

* **Speed.** At its default rate a Windows voice took 6.8 s over *"Control,
  reports of a vehicle driving dangerously, all units respond"* — about half
  the pace of real radio traffic — and every call behind it went stale
  waiting. Rate does not scale linearly on those voices either: 1.3 only took
  that line to 6.1 s, 2.1 to 4.9 s. So the rates are 1.8 to 2.1 — but only for
  the Windows desktop voices. Every other engine takes the rate at its word,
  and on a phone 2.0 really was double speed: *"the voices say the stuff way
  too fast"*. A phone's own voices report themselves as local, which is what
  used to earn the full rate, so `rateFor` now asks what the engine is — a
  local `Microsoft` voice that is not a natural one — and gives everything else
  the gentle version, about 1.25 to 1.35.
* **Staleness.** A call that has waited more than ten seconds is about
  something that has already happened — "PIT authorised" after the PIT — and is
  dropped rather than read out late.
* **Traffic.** The intercept solver re-picks junctions every second, and every
  unit announced every change: once calls took real time to say, *"U2 — cut
  them off at the roundabout, 4s"* was sixty lines a minute and more than half
  of everything on the net. A unit now says it is going to cut them off when it
  takes the job, and again only twenty seconds later.

A priority call from Control opens with a short attention beep, at most once
every 24 s. One transmission at a time: two units never talk over each other on
a real net, and it is the queueing that makes it sound like a net rather than a
soundboard. Muting cancels the speech directly, since it does not go through the
master volume, and so does leaving the page — speech otherwise carries on
through a reload, into the menu.

### What the police say

The dispatcher only ever spoke when it made a decision, so for most of a chase
the net was silent and nothing on it told you what they could see.
`game/commentary.js` watches the chase and reports it, the way a real pursuit
does — it never decides anything:

| When | Who | Says, for example |
|---|---|---|
| a unit takes the lead | the unit | *"Unit 2, primary, behind an orange sports car, southbound."* |
| a second unit is on you | the unit | *"Unit 1, backing up Unit 2."* |
| every 22–30 s while they can see you | primary | *"Unit 1, coming up to Eighth Street and Ashcroft Road, 80."* — or *motorway, northbound*, *they're slowing*, *losing ground* |
| through a red light, mid-chase | whoever saw it | *"…through a red at Sixth Street and Bright Lane."* |
| through a red light **in front of a patrol car**, no chase | the patrol car | *"U1, a blue-grey coupe just ran the red at Market Place and The Shambles. Going after it."* — and that starts the chase |
| off the road | primary | *"…they've left the road."* |
| you hit something, or ram a unit | primary, or the unit | *"…they've hit something, still mobile."* / *"…they've rammed us!"* |
| a police car is wrecked | the unit | *"…we're out, car's disabled."* |
| the wanted level rises | Control | pursuit authorised → tactical contact → authorised to box → critical incident |
| they lose sight | last primary, then Control | *"…lost visual, last seen eastbound on Sixth Street."* / *"all units, last seen on Carrick Road. Search the area."* |
| still searching | Control | *"any units, anything on that vehicle?"* |
| they find you again | the spotter | *"…eyes on! northbound on Faraday Road."* |
| air support has you in the light | India 99 | *"we have them, northbound. I'll commentate"*, then its own running commentary |
| you are pinned | nearest unit | *"they're stopped! Moving in."* → *"blocked in, going to the driver."* — or *"they've pushed free!"* |
| arrested | the unit, then Control | *"one detained"* → *"received. All units, stand down."* |

**Running a red light starts a chase** if a police car saw it. `Game._checkRedLight`
counts a red as run when the car is within nine metres of a signalised junction,
still above 30 km/h, with its own approach on red; the witness is the nearest
working police car within 120 m that has a line of sight — not the dispatcher's
shared knowledge, which at zero heat only reaches about 70 m, far less than a
patrol car sitting at a junction can see across. `tests/redlight.js` pins a
light on red and drives through it three ways: watched with no chase (heat 0 →
1, the witness line, then Control), unwatched (nothing), and mid-chase (the
primary reports it).

**Nothing says the same thing twice.** Every line on the net — commentary,
dispatcher, roadblocks, air support — comes from a set of wordings
(`game/phrases.js`), and a set will not reuse a wording until most of the
others have had a turn. On top of that `Game.radio` drops any sentence that went
out word for word in the last 45 seconds of game time. A search used to say
"still no further sighting, keep looking" three times in a row; the scripted
two-minute chase in `tests/commentary.js` now has no exact repeats at all.
Patrol cars coming on duty say so — *"U2, show me on duty"* — rather than that
they are responding to a chase that does not exist; only once there is a chase
does a new car say it is on its way.

Primary has hysteresis, so two cars trading places a length apart do not hand
it back and forth. And once you are arrested nothing else gets on the net:
before, units kept announcing intercepts after Control had stood everybody down.

**Less of it, and never late.** The net used to be talking almost all the time,
and a call could reach the speaker ten or fifteen seconds after the thing it
described — "PIT authorised" read out after the car had already spun. Nothing
could be dropped once queued, and every line took five seconds to say. Now:

* **Lines are short.** Radio traffic is clipped: *"U2, PIT authorised."*, not
  *"U2, tactical contact authorised, go when ready."* Nearly every wording was
  cut, most by half. Timed on this machine's voices, a line costs about 1.6 s
  of clicks and chirps plus one second per 16–19 characters, so length is
  airtime.
* **Routine lines only go out into a gap.** Commentary, units en route, units
  going for an intercept need two seconds of silence on the net, and at least
  12 s since the last routine line from anyone. With no gap they are not queued
  — they wait, unsaid and unspent, for the next one. The primary's running
  commentary is every 22–30 s rather than 11–15; secondary, off-road, crashes,
  air support and the search all have longer cooldowns; box calls, PIT calls
  and rolling blocks are each limited to one every 20–40 s whoever makes them.
* **A call that waits too long is dropped.** 4.5 s for a priority call, 3 s for
  anything else — about one line's worth. A newer call of the same kind replaces
  a waiting one, and the most important waiting call goes first (the arrest,
  then priority calls, then the rest).
* **Urgent calls cut routine ones off.** A priority call arriving while
  commentary is being read out stops it mid-sentence (key-up crash and all) and
  goes straight out.
* **The helicopter no longer flaps.** It launches at five stars but only goes
  home below four: heat hovering at five had it launch, stand down and launch
  again inside twenty seconds, with a call each time.

`tests/commentary.js` measures this on what would actually be *heard*: it runs
the game's real radio queue on a simulated clock, holding each line on the air
for as long as the voice takes to say it. `__runCommentary('scripted')` packs
every phase of a chase into two minutes; `__runCommentary('natural', 180)`
leaves the police to find and chase the car on their own. The same test on the
previous commit and on this one:

| | lines aired | channel busy | wait for the channel (median / worst) |
|---|---|---|---|
| scripted 130 s, before | 27 (12.8 a minute) | 97% | 7.9 s / 19.2 s |
| scripted 130 s, after | 26 (11.8 a minute) | 77% | 0.0 s / 5.9 s |
| natural 180 s, before | 33 (11.0 a minute) | 85% | 4.4 s / 14.2 s |
| natural 180 s, after | 25 (8.3 a minute) | 52% | 0.0 s / 3.6 s |

The scripted run's worst case is the closing "all units, stand down" after an
arrest, which is allowed to wait; nothing else in it waited more than 3.8 s.
The scripted run barely airs fewer lines because it is built to be saturated —
four escalations in seventy seconds — and shorter lines mean more of them fit;
what changes is that they go out when they are true. Before, the game tried to
say 73 lines in it and 118 in the natural run, and the queue read out whatever
it could hold however late it was; now it tries 33 in each and drops the ones
that miss their moment.

`tests/radio.js` measures what can be measured: the channel (white noise in,
0.1% below 300 Hz, 88% between 300 Hz and 3 kHz), the key-up crash against the
opening click (3.1×), what every line becomes when read aloud, the voice choice
on this machine and on lists it does not have, and — live, through the real
speech engine — three priority calls made at once (the first two spoken one at
a time, the third dropped for waiting too long), a routine line cut off by an
urgent one, and silence on mute.

### The signalling

A real digital net wraps every call in machine noise, and it is a lot of the
character. Around each transmission:

* **Control** opens with a short data burst — frequency-shift keying between
  1200 and 1800 Hz a few milliseconds a bit, with runs of the same bit rather
  than a steady alternation, which is what makes it a "brrrp" rather than a
  beep — and sends another as it lets go. Priority calls get the attention beep
  first, now as often as every nine seconds rather than twenty-four.
* **A unit** gets three quick talk-permit chirps before it can speak, a couple
  of pops of static while it does, and a rising roger beep as it lets go.
* **Between calls** the channel is not silent: every 14 to 32 seconds, if it is
  clear, somebody keys up and says nothing, a terminal sends a status burst, or
  a stray roger beep comes through.

All of it goes through the radio channel. Measured against the key-up crash,
which stays the loudest moment of a call: data burst 0.52×, talk-permit chirps
0.42×, roger beep 0.48×, attention beep 0.83×, crackle 0.30×.

### No recorded chatter

For a while two recordings of real police radio traffic played in the gaps
between calls, and stood in for the voice on a machine with no speech engine.
They were taken out on request, files and all. The net between calls is back to
what the game makes itself — somebody keying up and thinking better of it, a
status burst, a distant roger beep (`_pumpNetNoise`) — and with no English
voice a call is now just the key going down and up with nothing readable in
between.

### The siren

It has to be recognisable as a siren, and the first one was not. A square wave
swept slowly over a narrow interval, muffled by a fixed lowpass well below its
own harmonics, played quietly behind an engine: the report from the other side
of the screen was *"a weird sound, almost music, I don't know what it is"* —
which is exactly what it was.

What makes the real thing identifiable is a bright, harmonically rich tone
through a resonant horn sweeping a wide interval, and a *pattern* that carries
meaning. So: sawtooth for the harmonics, a second voice a fifth above and three
cents out so the pair beats the way two real horns do, and a bandpass riding an
octave above the fundamental — which stops the sweep sounding like a filter
opening and starts it sounding like a horn. Then **wail** while they are working
their way towards you, 640–1540 Hz over three seconds; **yelp** inside 55 m,
the same interval in a third of a second. The switch is information: the pattern
changing is how you know the car behind has closed without taking your eyes off
the road.

`tests/siren.js` records what the oscillators are *asked* for, rather than
reading the nodes back — `setTargetAtTime` is an exponential approach on the
audio clock, which does not advance between synchronous calls, so sampling the
node reports a sweep that never leaves its starting note:

| | |
|---|---|
| wail | 640–1540 Hz, 3.00 s cycle |
| yelp, inside 55 m | 640–1540 Hz, 0.33 s cycle |
| second voice | 1.502 × the fundamental |
| horn | 1.90 × the fundamental |
| level at 20 / 60 / 120 m | 0.060 / 0.035 / 0.010 |
| beyond 190 m | silent |

The radio's attention signal got the same treatment for the same reason. Two
sine notes a fifth apart, a fifth of a second each, is a real paging convention
and at game volume it reads as a little tune playing every time the net opens.
One short square beep through the channel's own band limiting belongs to a
radio instead. And the synthetic speech now *slides* between syllables: a 13%
stress on top of a 12% spread is three semitones held flat, and discrete
intervals held steady is the definition of a melody, which is why the radio
sounded like it was singing.

### Everything else

Intake roar that swells with revs, narrow-band tyre squeal driven by the worst
wheel's slip, wind noise from road speed, and one-shot impact thuds. A gentle
limiter sits on the output: engine at full chat, siren alongside and a collision
thud all land together often enough that without one the mix clips exactly when
it matters. Worst case measured at 0.53 peak — no clipping.

### The engine sits under the radio

The engine was the loudest thing in the mix and talked over the calls. It is
halved (`ENGINE_VOLUME`, intake roar included), and it ducks by a further 45%
while a call is being spoken — easing down over a fraction of a second and back
up over about a second. The ducking is the only way to make the voices louder
than they are: the speech engine plays outside Web Audio and is already at its
maximum volume of 1.

Measured at the master bus, Stiletto, RMS:

| | before | after |
|---|---|---|
| idle | 0.020 | 0.010 |
| cruising, 4 000 rpm | 0.042 | 0.022 |
| flat out, 7 500 rpm | 0.077 | 0.036 |
| flat out, during a call | 0.077 | **0.022** |

**The male voice needed more.** It was the one that was hard to hear, and
rendering the same sentence through the Windows speech engine Chrome uses
showed why: Hazel came out at −16.5 dBFS, Susan at −15.6, and George at
−23.5 — seven or eight dB quieter before the game touches it. Nothing can
raise a speech voice above full volume, so the duck is per speaker instead: the
mix drops 5.4 dB under Control and 11.8 dB under a unit, and the siren, tyres
and wind now go down with the engine, since the siren sweeps straight through
the band speech lives in and is loudest exactly when a nearby unit is talking.
The unit voice is also a touch slower and brighter (rate 1.8, pitch 1.08):
George is the fastest of the three at his default rate, and at 2.3 he was the
hardest to follow as well as the quietest. Measured flat out with a siren 40 m
away: 0.043 RMS with no call, 0.023 under Control, 0.011 under a unit.

The radio log that used to sit in the bottom right corner is hidden, since
everything on it is now spoken. It is still written to, so deleting one
`display: none` in `index.html` brings it back.

## Night and rain

Picked on the menu with two switches under the cars — **DAY / NIGHT** and
**DRY / RAIN** — and remembered for next time (`src/game/weather.js`).

**Night.** A dark sky and short fog, moonlight in place of the sun, and lights
that mean something. Your car throws a real headlight beam down the road ahead
(one spotlight, no shadows); every car on the road has glowing head and tail
lamps; every street lamp has a halo and a pool of light on the ground under it,
and goes out if you knock it over; the police light bars glow twice as big and
the helicopter's searchlight is much brighter — so the police are much easier
to see coming, and the light on you is much easier to see as well.

**Rain.** Rain falling round the camera — streaks fixed in the world and
wrapped into a box that follows you, so they fall straight past rather than
travelling with the car — a grey sky, closer fog, darker wet roads, the sound
of it, and **20% less grip** for every car on every surface. The police drivers
plan their braking on the same wet grip (`Vehicle.surfaceMu`), so they find it
as hard as you do.

Everything that glows is additive points or instanced quads: one draw per kind
of light however many there are. A real light per street lamp would be hundreds
of lights, and nothing — least of all a phone — would draw that.

## Score

A run lasts until you are arrested. Getting away does not end it — the town
carries on and so does the score — so the way to a big number is to keep
getting chased and keep getting away. The score sits under the wanted stars,
each bonus rises out from under it as it lands, and the arrest screen says what
the run was worth and whether it is a new best.

| | points |
|---|---|
| every second with the police after you | 5 / 10 / 20 / 35 / 60 at one to five stars |
| getting away | 400 × the most stars that chase reached |
| getting past a roadblock | 300 |
| a police car wrecked while you were close by | 250 |
| a near miss — a police car past you at speed, close enough to touch, no contact | 100 |

So surviving at five stars is worth twelve times surviving at one, and a
five-star escape is worth 2 000 on its own. The best ten runs are kept in the
browser (`localStorage`, `pc.scores`) with the car, the map, how long the run
lasted and the most stars it reached, and the top five are on the menu
(`src/game/score.js`). Checked by driving a chase by hand: 12 s at four stars
and an escape came to 2 020, five more seconds at two stars to 2 069, and the
arrest saved it as a new best and cleared the score for the next run.

## The maps

Two, chosen from the menu at startup. Press **M** in game to come back and
switch. Both are 2 × 2 km, generated from authored layout rules with a fixed
seed, so each is identical every run.

### Ashfield City — grid

A dense downtown grid, a park superblock, thinned suburbs, an industrial strip,
a roundabout, a ring **motorway** open at the verges with six slip roads, and
winding **country** roads with hedgerows and a hamlet outside it. Sightlines run
straight down every street and the block structure is regular, so the dispatcher
can predict your route unusually well.

### Wexbury — organic market town

Built the way an English town accreted rather than the way one is planned:

* a medieval core of short crooked lanes around a market square,
* concentric ring lanes at whatever radius the town happened to stop at, joined
  by only about two thirds of the possible radial links — the missing ones are
  the point, because a full spiderweb is as predictable as a grid,
* long A-roads striking out to other towns, wandering as they go,
* post-war estates of crescents and cul-de-sacs hung off them,
* a dual carriageway **bypass** round one side, joined by **roundabouts** rather
  than slip roads, because that is how a bypass joins a town here,
* B-roads between hedgerows out to a village.

Buildings are placed along road *frontages* rather than inside blocks, which is
what produces terraced streets and makes the lanes feel enclosed: shops crowd
the pavement in the centre, terraces run in unbroken rows along the Victorian
streets, detached houses sit back behind gardens further out, and farms are
scattered along the B-roads. Nothing meets at a right angle unless it happens to.

Shared terrain, surfaces, road meshes and scenery live in `world/common.js`; a
map generator only has to lay out a road graph and decide where buildings go.

Two invariants the generator enforces, because both are the kind of thing that
silently breaks a chase:

* **No building is ever placed on a road.** The block inset handles the grid,
  but country roads and village lanes are laid out afterwards with no knowledge
  of the city, so every candidate building is finally tested against the road
  graph and dropped if it overlaps one.
* **Every tree is solid.** Woodland is scenery you can crash into, not a
  backdrop you drive through.
* **Slip roads have no sharp corners.** The approach is a Bezier that arrives
  already pointing along the merge taper, and a candidate junction is rejected
  outright if the resulting road would turn more than about 72 degrees
  anywhere -- so a node too close to the anchor is passed over for one that
  leaves room.
* **No slip road cuts across the traffic.** They merge at about 23 degrees
  after running alongside the carriageway for 125 m, each junction claims its
  own stretch of ring, and a candidate junction is rejected outright if the
  ramp's approach would cut across the traffic to reach it. Country roads, laid
  out afterwards, *do* cross the ring, and those crossings are now real
  junctions rather than paint — see **Crossings the graph did not know
  about** — which is how a unit joins the motorway anywhere but a slip road.

Every road is registered in a graph with widths, speeds and junction types, which
is what the AI routes over. The minimap is heading-up: the map turns under a
fixed marker, with an `N` pointer for orientation.

### The edge of the map

The ground is a plate 2.4 km square, 200 m of open field wider than the road
network on every side, and past it there is nothing at all. There used to be
nothing stopping you either: one straight run across the fields and the car went
over the edge and fell forever. Nothing caught that, because nothing was looking
for it — **R** rights a car that is stopped or upside down, and a falling one is
neither, so the chase carried on around a player who was half a kilometre under
the map at terminal velocity, with no way back into it short of restarting. A
police car that went over was worse: the roster measures how far away a unit is
across the ground, so a car three hundred metres down was still counted as one
of the cars chasing you, and was never replaced.

So there is an invisible wall where the grass runs out, four metres inside an
edge you can see coming. It costs nothing to hit: it is not scenery you drove
into, it is the end of the world with something in front of it, and charging
64% of the bodywork — which is what it did when it was an ordinary wall — is a
punishment for finding the edge of the map. It still thuds and shakes the
camera, because you did hit something, and every car gets that, not only the
player's.

Behind it, `Game._catchFallen` checks every frame for a car below y = −14 and
puts it back: the player is towed to the nearest road, upright and stopped, and
anything else is retired so the roster sends a replacement. It should never fire
now that the wall is there. It exists because a car under the map is not a state
the rest of the game can cope with, and both of the ways it used to happen were
silent. `tests/edge.js` drives at the boundary from all four sides and then
cheats past it to check the catch.

---

### The garage

Each map has a petrol station with a repair bay, marked on the minimap with a
green spanner that sits on the edge of the map when it is out of range. Drive
into the bay — the hatched square on the workshop floor — and stop. After
three seconds sitting still the bay turns green and the car starts to mend at
5% a second, until it is back to 100% or you move; the meter at the bottom of
the screen counts the three seconds and then the repair. It works in a chase
too, but stopping is how you get arrested, so it is only safe if you have got
some distance first.

**The workshop is open at both ends** — two walls and a roof, no back. It had
one, which made the bay a dead end: drive in to mend the car and the only way
out is a reverse, with whoever is chasing you arriving at the single entrance.
Open at the back it is a building you can go through, which is worth having in
a chase and costs nothing — the sides and the roof still make it a workshop to
look at, and the bay is still the bay.

The site is found, not authored, so the same code (`src/game/garage.js`)
serves both maps: a straight stretch of ordinary road a few hundred metres from
the start with a 34 × 24 m lot of clear ground beside it — no road, no
building, no tree. The ground under the lot is repainted as footway in the
surface grid, so it is level (the physics reads its height from there) and
flush with the pavement you cross to get in, and street furniture is never
placed across its entrance. In the city it is on Ninth Street, 394 m from the
start; in Wexbury the town streets are built up to the kerb, so it is out on
Fosse Way at the edge of town, 359 m out.

`tests/garage.js` checks it on whichever map is loaded: the lot is level
(0.138–0.140 m), a car pointed at the bay from the road drives in with no
collisions, nothing happens for the first 2.8 s, the repair runs at 5.0% a
second, it stops when the car drives off, and 30% damage is gone 12 s later.

## Apple mode

The game plays harder on Apple hardware. It is a joke, it is deliberate, and
nothing on screen announces it:

* every hit costs the player's car **twice** what it costs anyone else,
* the wanted level climbs **three times** as fast, which is most of what makes
  it hard — the number of cars, the kinds of car, the tactics that unlock and
  how hard each unit presses all read off the tier, so one number moves all of
  them. Three minutes to five stars rather than ten.
* and Control will not stop going on about your phone.

Every escalation gives the device as the reason it is being authorised —
"tactical contact authorised, the subject is an Apple user" — because that is
the one moment the joke has something to hang on: the response genuinely is
stepping up, and saying why lands better than the same gag arriving with
nothing happening. Between those, the ambient lines are all the same joke told
as radio traffic, and the joke is that the force's official advice is to buy an
Android.

Every one of those lines is also put on screen, in the middle, for three
seconds before it fades. The radio alone is deaf: with the sound off the joke
happened to nobody at all, and even with it on a line goes past while you are
busy driving.

The radio is the only tell, and that is on purpose. A chase where dispatch
keeps making jokes about dongles is obviously a joke; the same chase in silence
is just a game that feels unfairly hard and gets closed. The lines are ribbing
about a brand and nothing more — no invented facts, no pretending to be anyone.

None of it applies when there is somebody else in the room. Handicapping one
player's car in a game against other people is not the same joke as
handicapping their own run, and the heat is shared -- the escapee's wanted
level is sent to every police player -- so an Apple host would drag everybody
up to five stars with them. Hosting a game nobody has joined yet still counts
as playing on your own, so the test is of people rather than of sessions, and
it re-checks itself whenever somebody arrives or leaves.

A police player can use it too, in a game they did not start. The heat is the
escapee's — it is worked out on their machine and sent out with the world — so
a guest setting it locally would be overruled by the next packet a twentieth of
a second later. They send a request instead and the machine that owns the chase
does it; the answer comes back the ordinary way, so everybody sees the same
stars. It freezes the score the same as doing it yourself, because it is the
same free stars.

**Type FIVE** to jump straight to five stars, and with the debug telemetry up
(F3) the number keys set any level. Using either stops the run scoring, for
the rest of the run: five stars is worth about sixty points a second, and a
typed word at the top of the table would make the rest of it meaningless. What
was earned before it stands, and the score readout says OFF so a number that
has quietly stopped moving does not look like a bug.

**Tap the title on the menu seven times** to switch the whole thing off — or
on. That is the way out for somebody who actually owns the phone: typing APPLE
needs a keyboard and the people most likely to want this gone are holding one
without. It says loudly which way it just went, and being switched off sticks
between sessions, because otherwise they would be turning it off every time
they opened the game. Asking for it on a machine that is *not* Apple only
lasts for the tab, since that is a way of looking at the joke rather than a
preference.

**Type APPLE** to be treated as an Apple device from anything, and again to
stop; `?apple=1` does the same at load, for a phone with no keyboard. It is
remembered for the tab, so a reload keeps it and a new window starts honest.
Without it there is no way to look at any of this from a machine that is not
one. Two of those five letters do other things — A steers and P pauses — so
typing it twitches the wheel and blinks the pause panel on the way past, and
the shortcut ends by unpausing so a fast typist is not left sitting on the
pause screen.

Detection is in `core/platform.js` and it is not reliable, because it cannot
be: an iPad has claimed to be a Mac since iPadOS 13 (the touch-point count is
the only thing that gives it away), and any user agent can be changed by
whoever is holding the device. The trap worth knowing about is that **every
Chrome and every Safari on every platform has "AppleWebKit" in its user
agent**, Windows and Android included, so a test matching on "Apple" catches
the entire web. `tests/apple.js` keeps a table of real user agent strings —
four Apple, four not, all eight containing the word — and checks the two things
the flag actually does by doing them.

## Performance

Measured on the target machine (Intel Core 3 N355, Intel UHD graphics, 8 GB), at
1280×720 with twelve cars in an active pursuit:

| | |
|---|---|
| Physics + AI | 1.2 ms |
| Render (GPU-synced) | 0.6 ms |
| **Total** | **1.8 ms/frame, against a 16.7 ms budget** |
| Draw calls | 45 |
| Triangles | 79 k |

Note these were taken with the browser pane not compositing, so the GPU figure is
optimistic; expect it to be higher in normal use. There is a wide margin either
way. If the frame rate does drop the game degrades itself: shadows off below
40 fps, then reduced resolution below 28.

## Layout

```
serve.ps1              dev server (also accepts POSTed screenshots to shots/)
deploy-azure.ps1       publish the game and its server to the Azure Web App
.github/workflows/
  deploy.yml           the same, on every push to master
server/
  PoliceChase.Server.csproj
  Program.cs           the ASP.NET host: static files, types, compression
  Rooms.cs             multiplayer rooms, and the packet relay at /ws
index.html             canvas, HUD markup, import map
src/
  main.js              boot, fixed-timestep loop, rendering, spawning
  physics/
    world.js           Rapier wrapper, collision groups, raycasts
    tyre.js            combined-slip Pacejka, load sensitivity
    vehicle.js         suspension, tyre forces, gearbox, damage
  world/
    roadgraph.js       nodes/edges, A*, reachability, path smoothing
    common.js          shared terrain, surfaces, road meshes, trees
    citygen.js         Ashfield City — grid, motorway ring, slip roads
    towngen.js         Wexbury — organic rings, A-roads, bypass, village
    maps.js            map registry
  ai/
    dispatcher.js      perception, role assignment, intercept solver
    officer.js         per-unit state machine
    driver.js          pure-pursuit steering, counter-steer, speed planner
    tactics.js         PIT and rolling box
  net/
    session.js         multiplayer: rooms, roles, car packets, interpolation
  game/
    vehicles.js        car specs and procedural bodywork
    livery.js          procedural police livery texture atlas
    heat.js            wanted level, cooldown, arrest
    roadblock.js       roadblock siting, construction, despawn
    helicopter.js      air support at five stars
    garage.js          the petrol station and its repair bay
    score.js           the score and the best runs
    weather.js         night and rain
    bodies.js          SUV, van and Badger bodywork, and the police kit
    audio.js           sampled + synthesised engine, tyres, siren, impacts, radio
    camera.js  hud.js  effects.js
  core/
    menu.js            car, map and radio voice selection at startup
    input.js           keyboard and gamepad, merged with touch
    touch.js           on-screen steering, pedals and buttons for phones
```

### Tuning

The handling knobs are ordinary engineering quantities in `src/game/vehicles.js`:

* `gripBias.rear` — extra rear grip. Raise it for stability, lower it to let the
  tail out more easily.
* `suspension.arbRear` vs `arbFront` — roll stiffness split, the strongest
  balance lever. A stiffer rear bar means more oversteer.
* `frontWeight`, `brakes.handbrakeTorque`, `gears`, `finalDrive`.
* `durability` divides incoming collision damage.
* `tractionControl` (0–1) and `tcSlipThreshold` — how hard the engine is backed
  off when the rears spin. Set `tractionControl: 0` for no assistance at all.
* `steering.latLimit` / `overshoot` / `slipAllowance` size the available lock;
  `rate` and `returnRate` are how fast the rack winds on and unwinds. Raising
  `rate` makes the car feel sharper and more prone to scrubbing its fronts.

Tyre character lives in `TYRE_ROAD` in `src/physics/tyre.js`; `loadSensitivity`
and `slidingFriction` are the two that change the feel most. `slidingFriction` is
delicate — set it too high and a locked tyre keeps its cornering force, which
quietly stops the handbrake working.

Police aggression is in `SKILL` (`src/ai/driver.js`) and the per-tier rules table
at the top of `src/ai/dispatcher.js`.

Traffic drives on the **left**; flip `DRIVE_SIDE` in `src/world/roadgraph.js` for
right-hand traffic.

### Not yet implemented

Spike strips, elevated overpasses (the motorway is grade-level throughout), and
civilian traffic — which is the one that would give the traffic signals someone
to hold up besides the police.
