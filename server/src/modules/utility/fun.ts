import { register, UsageError } from "../../commands/registry";
import { Level } from "../../permissions";
import { EIGHT_BALL, parseDice, plainMentions, parseRps, pick, rollDice, rpsOutcome, RPS, splitChoices } from "./logic";

// Fun commands: 8ball, coinflip, roll, choose, rps. All local randomness.

function quote(text: string): string {
  return plainMentions(text).replace(/\s+/g, " ").slice(0, 200);
}

export function registerFun(): void {
  register(
    {
      name: "8ball",
      category: "Fun",
      level: Level.Member,
      usage: "<question>",
      description: "Ask the magic 8-ball a yes-or-no question.",
      async run(ctx) {
        const question = ctx.args.rest();
        if (!question) throw new UsageError("Ask a question.");
        await ctx.reply(`🎱 ${pick(EIGHT_BALL)}`);
      },
    },
    {
      name: "coinflip",
      aliases: ["flip"],
      category: "Fun",
      level: Level.Member,
      usage: "",
      description: "Flip a coin.",
      async run(ctx) {
        await ctx.reply(`🪙 **${pick(["Heads", "Tails"])}**`);
      },
    },
    {
      name: "roll",
      category: "Fun",
      level: Level.Member,
      usage: "[NdM[+K]]",
      description: "Roll dice. Defaults to one six-sided die.",
      details: ["`roll` · `roll d20` · `roll 3d6+2` · `roll 100` (1-100). Up to 100 dice with up to 1000 sides."],
      async run(ctx) {
        const dice = parseDice(ctx.args.word());
        if ("problem" in dice) throw new UsageError(dice.problem);
        const { rolls, total } = rollDice(dice);
        const label = `${dice.count}d${dice.sides}${dice.modifier ? (dice.modifier > 0 ? `+${dice.modifier}` : dice.modifier) : ""}`;
        const detail = rolls.length > 1 || dice.modifier ? ` (${rolls.length > 30 ? `${rolls.slice(0, 30).join(", ")}, …` : rolls.join(", ")}${dice.modifier ? ` ${dice.modifier > 0 ? "+" : "-"} ${Math.abs(dice.modifier)}` : ""})` : "";
        await ctx.reply(`🎲 ${label}: **${total}**${detail}`);
      },
    },
    {
      name: "choose",
      category: "Fun",
      level: Level.Member,
      usage: "<a | b | c>",
      description: "Pick one of several options for you.",
      async run(ctx) {
        const options = splitChoices(ctx.args.rest());
        if (options.length < 2) throw new UsageError("Give at least two options separated by |.");
        await ctx.reply(`🤔 I choose **${quote(pick(options)).replace(/\*/g, "")}**`);
      },
    },
    {
      name: "rps",
      category: "Fun",
      level: Level.Member,
      usage: "<rock|paper|scissors>",
      description: "Play rock, paper, scissors against Taproot.",
      async run(ctx) {
        const mine = parseRps(ctx.args.word());
        if (!mine) throw new UsageError("Pick rock, paper or scissors.");
        const theirs = pick(RPS);
        const result = rpsOutcome(mine, theirs);
        const icon = { rock: "🪨", paper: "📄", scissors: "✂️" };
        const verdict = result === "win" ? "You win!" : result === "lose" ? "I win!" : "It's a draw.";
        await ctx.reply(`${icon[mine]} vs ${icon[theirs]} I picked **${theirs}**. ${verdict}`);
      },
    },
  );
}
