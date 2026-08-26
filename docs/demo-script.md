# Recording docs/demo.gif

The one thing worth showing is the moment a run stops on its own: warning, wall,
top-up, resume. Everything else in the README is already covered by the two
still screenshots.

Target: **8–12 seconds**, under 2 MB, no cursor noise, readable at GitHub's
README width (roughly 800 px).

## Tools

```sh
brew install asciinema agg        # macOS
# Linux: pipx install asciinema && cargo install --git https://github.com/asciinema/agg
```

`asciinema` records the terminal as text, `agg` renders that to a GIF. Screen
recorders produce files that are several times larger and blurrier.

## Set the stage

Use a throwaway limits file so the demo cannot touch real limits, and pick a
small default so the wall arrives within the clip rather than after ten minutes
of real work:

```sh
export OPENCODE_BUDGET_FILE=/tmp/budget-demo.json
export OPENCODE_BUDGET_DEFAULT=0.05
export OPENCODE_BUDGET_WARN=0.5,0.8
rm -f /tmp/budget-demo.json
```

Then:

- Resize the terminal to **100x28**. Wider than that and the text is unreadable
  once GitHub scales the GIF down.
- Use a light-on-dark theme with a large font; the sidebar numbers are the
  point of the whole clip.
- Clear scrollback (`clear`) so the recording opens on an empty prompt.

## The take

```sh
asciinema rec docs/demo.cast --cols 100 --rows 28 --idle-time-limit 1
```

`--idle-time-limit 1` collapses any pause longer than a second, so thinking time
between turns does not have to be edited out afterwards.

Inside the recording, in order:

1. Start a task with enough work in it to cost real money — a refactor across a
   few files reads better than a toy prompt, because the sidebar number climbs
   visibly between turns.
2. Let it run until the **warning toast** appears. Hold still for a beat; do not
   type over it.
3. Keep going until the run **hits the limit** and is cancelled. Let the
   "Limit reached" toast sit on screen long enough to read.
4. Type `/budget +2`.
5. Show `continue` landing in the prompt box, press enter, and let one turn
   start. Stop recording there — the clip should end on the work resuming, not
   on it finishing.

Exit with `ctrl-d`.

## Render

```sh
agg docs/demo.cast docs/demo.gif \
  --font-size 20 \
  --speed 1.4 \
  --theme asciinema \
  --idle-time-limit 1
```

Check the result:

```sh
du -h docs/demo.gif      # aim for < 2 MB
```

If it is too heavy, in this order: raise `--speed`, cut the opening seconds with
`--cols`/trimming the cast file (it is plain JSON lines and safe to edit by
hand), then lower `--font-size`.

Keep `docs/demo.cast` in the repo. Re-recording a take that already worked is
much harder than re-rendering it with different flags.
