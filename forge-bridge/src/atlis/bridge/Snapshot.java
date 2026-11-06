// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

package atlis.bridge;

import java.util.HashSet;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import forge.game.Game;
import forge.game.GameEntityView;
import forge.game.GameView;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.card.CounterType;
import forge.game.combat.CombatView;
import forge.game.player.PlayerView;
import forge.game.spellability.StackItemView;
import forge.game.zone.ZoneType;
import forge.item.IPaperCard;
import forge.item.PaperCard;

/**
 * The whole table as one JSON object, from one seat's point of view.
 *
 * Full snapshots rather than deltas: a Commander board is a few hundred cards
 * at most, serialising it is sub-millisecond, and a full state can never
 * drift out of sync the way a missed delta can. Visibility is Forge's own
 * (mayView), so a hidden card is sent as its id alone.
 */
final class Snapshot {
    private final BridgeGui gui;
    private final Game game;
    private final JsonObject cards = new JsonObject();
    private final Set<Integer> seen = new HashSet<>();
    private boolean attackStep, blockStep;
    /** Options offered to the player are theirs to see, even from a hidden zone (a tutor shows your library). */
    private boolean forceVisible;

    Snapshot(BridgeGui gui, Game game) {
        this.gui = gui;
        this.game = game;
    }

    JsonObject build(GameView gv) {
        PlayerView you = gui.seat();
        boolean myTurn = you != null && gv.getPlayerTurn() != null && gv.getPlayerTurn().getId() == you.getId();
        attackStep = myTurn && gv.getPhase() == forge.game.phase.PhaseType.COMBAT_DECLARE_ATTACKERS;
        // From the moment attackers are declared, so ATLIS knows before the block step
        // whether you'll get one: Forge skips it when no block is legal (all fliers, say).
        blockStep = !myTurn && (gv.getPhase() == forge.game.phase.PhaseType.COMBAT_DECLARE_BLOCKERS
            || gv.getPhase() == forge.game.phase.PhaseType.COMBAT_DECLARE_ATTACKERS);

        JsonObject s = new JsonObject();
        s.addProperty("type", "state");
        s.addProperty("turn", gv.getTurn());
        s.addProperty("phase", gv.getPhase() == null ? null : gv.getPhase().name());
        s.addProperty("activePlayer", gv.getPlayerTurn() == null ? null : gv.getPlayerTurn().getId());
        s.addProperty("mulligan", gv.isMulligan());
        s.addProperty("gameOver", gv.isGameOver());
        s.addProperty("winner", gv.isGameOver() ? gv.getWinningPlayerName() : null);
        s.addProperty("you", gui.seat() == null ? null : gui.seat().getId());

        JsonArray players = new JsonArray();
        for (PlayerView p : gv.getPlayers()) players.add(player(p, gv));
        s.add("players", players);

        JsonArray stack = new JsonArray();
        for (StackItemView si : gv.getStack()) stack.add(stackItem(si));
        s.add("stack", stack);

        s.add("combat", combat(gv.getCombat()));
        s.add("prompt", gui.promptJson());
        s.add("log", log(gv));
        s.add("cards", cards);
        return s;
    }

    private JsonObject player(PlayerView p, GameView gv) {
        JsonObject o = new JsonObject();
        o.addProperty("id", p.getId());
        o.addProperty("name", p.getName());
        o.addProperty("ai", p.isAI());
        o.addProperty("life", p.getLife());
        o.addProperty("lost", p.getHasLost());
        o.addProperty("priority", p.getHasPriority());
        o.addProperty("landsPlayed", p.getNumLandThisTurn());
        o.addProperty("maxLands", p.hasUnlimitedLandPlay() ? -1 : p.getMaxLandPlay());
        o.add("counters", counters(p));
        o.addProperty("highlighted", gui.isHighlighted(p));

        JsonObject mana = new JsonObject();
        // The pool is keyed by Forge's ManaAtom codes: W=1, U=2, B=4, R=8, G=16,
        // colorless=32. (MagicColor's colorless is 0, but the pool never uses
        // it: reading 0 showed every {C} - Eldrazi Spawn, Sol Ring - as none.)
        String[] names = { "W", "U", "B", "R", "G", "C" };
        byte[] bits = { forge.card.mana.ManaAtom.WHITE, forge.card.mana.ManaAtom.BLUE, forge.card.mana.ManaAtom.BLACK,
            forge.card.mana.ManaAtom.RED, forge.card.mana.ManaAtom.GREEN, forge.card.mana.ManaAtom.COLORLESS };
        for (int i = 0; i < names.length; i++) mana.addProperty(names[i], p.getMana(bits[i]));
        o.add("mana", mana);

        // Commander: who commands what, how often it was cast (tax), and the
        // combat damage THIS player has taken from every commander in play.
        JsonArray cmd = new JsonArray();
        JsonObject cast = new JsonObject();
        for (CardView c : nn(p.getCommanders())) {
            cmd.add(c.getId());
            cast.addProperty(String.valueOf(c.getId()), p.getCommanderCast(c));
            card(c);
        }
        o.add("commanders", cmd);
        o.add("commanderCast", cast);
        JsonObject dmg = new JsonObject();
        for (PlayerView other : gv.getPlayers()) {
            for (CardView c : nn(other.getCommanders())) {
                int d = p.getCommanderDamage(c);
                if (d > 0) dmg.addProperty(String.valueOf(c.getId()), d);
            }
        }
        o.add("commanderDamage", dmg);

        JsonObject zones = new JsonObject();
        for (ZoneType z : new ZoneType[] { ZoneType.Hand, ZoneType.Battlefield, ZoneType.Graveyard, ZoneType.Exile, ZoneType.Command }) {
            zones.add(z.name().toLowerCase(), zone(p.getCards(z)));
        }
        o.addProperty("library", p.getZoneSize(ZoneType.Library));
        // The top of the library, when Forge lets this seat see it: "you may
        // look at the top card any time" (Vesuvan Drifter), "play with the top
        // card revealed" (Conspicuous Snoop), Future Sight-style "cast from the
        // top". Its playable flag then says whether it can be cast from there.
        try {
            Iterable<CardView> lib = p.getCards(ZoneType.Library);
            CardView top = lib == null ? null : (lib.iterator().hasNext() ? lib.iterator().next() : null);
            if (top != null && gui.mayView(top)) {
                o.addProperty("libraryTop", top.getId());
                card(top);
                // Forge's actionable-highlight scan skips the library, so ask
                // the rules directly whether the seat can play it from there.
                if (gui.seat() != null && p.getId() == gui.seat().getId() && game != null) {
                    Card real = game.findById(top.getId());
                    forge.game.player.Player me = null;
                    for (forge.game.player.Player pl : game.getPlayers()) if (pl.getId() == p.getId()) me = pl;
                    if (real != null && me != null && !real.getAllPossibleAbilities(me, true).isEmpty()) {
                        cards.getAsJsonObject(String.valueOf(top.getId())).addProperty("playable", true);
                    }
                }
            }
        } catch (RuntimeException ignored) {
            // optional detail
        }
        o.add("zones", zones);
        // Why a card you hold can't be cast: the permanents whose "can't be
        // cast" rule stops it right now (Rule of Law after your first spell,
        // Teferi at instant speed, Grand Abolisher on its owner's turn…).
        if (gui.seat() != null && p.getId() == gui.seat().getId() && game != null) {
            try {
                forge.game.player.Player me = null;
                for (forge.game.player.Player pl : game.getPlayers()) if (pl.getId() == p.getId()) me = pl;
                if (me != null) {
                    for (ZoneType z : new ZoneType[] { ZoneType.Hand, ZoneType.Command }) {
                        for (CardView v : nn(p.getCards(z))) {
                            Card real = game.findById(v.getId());
                            JsonObject co = cards.getAsJsonObject(String.valueOf(v.getId()));
                            if (real == null || co == null) continue;
                            JsonArray why = castBlockers(real, me);
                            if (why.size() > 0) co.add("cantCast", why);
                        }
                    }
                }
            } catch (RuntimeException ignored) {
                // optional detail
            }
        }
        return o;
    }

    /**
     * The static "can't be cast" rules stopping every way to cast this card,
     * each as {id, name, text} of the permanent that has it. Mirrors Forge's
     * StaticAbilityCantBeCast.cantBeCastAbility, but keeps who said no.
     * Empty when at least one way to cast it isn't stopped by any of them.
     */
    private JsonArray castBlockers(Card card, forge.game.player.Player me) {
        JsonArray out = new JsonArray();
        Set<Integer> got = new HashSet<>();
        boolean anyFree = false;
        boolean anySpell = false;
        forge.game.spellability.SpellAbility before = card.getCastSA();
        try {
            for (forge.game.spellability.SpellAbility sa : card.getSpells()) {
                anySpell = true;
                card.setCastSA(sa);
                boolean stopped = false;
                for (Card src : game.getCardsIn(ZoneType.STATIC_ABILITIES_SOURCE_ZONES)) {
                    for (forge.game.staticability.StaticAbility st : src.getStaticAbilities()) {
                        if (!st.checkConditions(forge.game.staticability.StaticAbilityMode.CantBeCast)) continue;
                        if (!forge.game.staticability.StaticAbilityCantBeCast.applyCantBeCastAbility(st, sa, card, me)) continue;
                        stopped = true;
                        if (got.add(src.getId())) {
                            JsonObject b = new JsonObject();
                            b.addProperty("id", src.getId());
                            b.addProperty("name", src.getName());
                            String d = st.hasParam("Description") ? st.getParam("Description") : st.toString();
                            b.addProperty("text", d == null ? "" : d.replace("CARDNAME", src.getName()));
                            out.add(b);
                        }
                    }
                }
                if (!stopped) anyFree = true;
            }
        } finally {
            card.setCastSA(before);
        }
        return anySpell && !anyFree ? out : new JsonArray();
    }

    private JsonArray zone(Iterable<CardView> list) {
        JsonArray a = new JsonArray();
        for (CardView c : nn(list)) {
            a.add(c.getId());
            card(c);
        }
        return a;
    }

    private void card(CardView c) {
        if (c == null || !seen.add(c.getId())) return;
        // Always describe the card's LIVE view. Views reached through other
        // objects (a player's commander list, a stack item's source) can be
        // stale copies — a commander attacking showed as untapped because its
        // command-list view was serialized first and the live one skipped.
        if (game != null) {
            try {
                Card live = game.findById(c.getId());
                if (live != null && live.getView() != null) c = live.getView();
            } catch (RuntimeException ignored) {
                // fall back to the view we were given
            }
        }
        JsonObject o = new JsonObject();
        o.addProperty("id", c.getId());
        if (!forceVisible && !gui.mayView(c)) {
            o.addProperty("hidden", true);
            o.addProperty("owner", c.getOwner() == null ? null : c.getOwner().getId());
            cards.add(String.valueOf(c.getId()), o);
            return;
        }
        CardView.CardStateView st = c.getCurrentState();
        o.addProperty("name", st.getName());
        o.addProperty("owner", c.getOwner() == null ? null : c.getOwner().getId());
        o.addProperty("controller", c.getController() == null ? null : c.getController().getId());
        o.addProperty("zone", c.getZone() == null ? null : c.getZone().name());
        o.addProperty("tapped", c.isTapped());
        o.addProperty("sick", c.isSick());
        o.addProperty("attacking", c.isAttacking());
        o.addProperty("blocking", c.isBlocking());
        o.addProperty("token", c.isToken());
        if (c.isToken()) {
            // Tokens have no printing; ATLIS finds art by name, colors and P/T.
            try {
                forge.card.ColorSet cs = st.getColors();
                o.addProperty("colors", (cs.hasWhite() ? "W" : "") + (cs.hasBlue() ? "U" : "") + (cs.hasBlack() ? "B" : "")
                    + (cs.hasRed() ? "R" : "") + (cs.hasGreen() ? "G" : ""));
            } catch (RuntimeException ignored) {
                // cosmetic
            }
        }
        o.addProperty("commander", c.isCommander());
        o.addProperty("faceDown", c.isFaceDown());
        o.addProperty("damage", c.getDamage());
        o.addProperty("type", st.getType() == null ? null : st.getType().toString());
        o.addProperty("manaCost", st.getManaCost() == null ? null : st.getManaCost().toString());
        o.addProperty("text", c.getText());
        o.addProperty("land", st.isLand());
        o.addProperty("creature", st.isCreature());
        if (st.isCreature() || st.isVehicle()) {
            o.addProperty("power", st.getPower());
            o.addProperty("toughness", st.getToughness());
        }
        if (st.isPlaneswalker()) o.addProperty("loyalty", st.getLoyalty());
        if (st.isBattle()) o.addProperty("defense", st.getDefense());
        o.add("counters", counters(c));
        CardView att = c.getAttachedTo();
        if (att != null) o.addProperty("attachedTo", att.getId());
        o.addProperty("selectable", gui.isSelectable(c));
        // Strength 1 = the player can act on it now; 2 = Forge's auto-pay would tap it.
        int weak = gui.getWeakSelectableStrength(c);
        o.addProperty("playable", weak >= 1 || freeManaReady(c));
        o.addProperty("autoTap", weak >= 2);
        o.addProperty("highlighted", gui.isHighlighted(c));
        printing(c, o);
        combatOptions(c, o);
        cards.add(String.valueOf(c.getId()), o);
    }

    /** One card's full data for a request option — e.g. library cards during a search, which aren't on the table. */
    static JsonObject optionCard(BridgeGui gui, Game game, CardView c) {
        Snapshot s = new Snapshot(gui, game);
        s.forceVisible = true;
        s.card(c);
        return s.cards.getAsJsonObject(String.valueOf(c.getId()));
    }

    /**
     * Forge's attack/block prompts don't mark candidates as selectable (its
     * desktop client lets you click anything and rejects illegal picks), so
     * ask the combat rules directly which of your creatures may attack or block.
     */
    private java.util.Map<Card, forge.game.combat.AttackRequirement> attackReqs;

    /** Which of the attacking player's creatures must attack this combat, worked out once per snapshot. */
    private java.util.Map<Card, forge.game.combat.AttackRequirement> attackRequirements() {
        if (attackReqs == null) {
            attackReqs = java.util.Collections.emptyMap();
            forge.game.combat.Combat cb = game.getCombat();
            if (cb != null) attackReqs = new forge.game.combat.AttackConstraints(cb).getRequirements();
        }
        return attackReqs;
    }

    /**
     * Can block something that's actually attacking you (or your planeswalkers) —
     * not just "is able to block in general": a reach-less creature can't block fliers.
     */
    private boolean canBlockAnAttacker(Card blocker) {
        forge.game.combat.Combat cb = game.getCombat();
        if (cb == null || !forge.game.combat.CombatUtil.canBlock(blocker, cb)) return false;
        int seat = gui.seat().getId();
        for (Card att : cb.getAttackers()) {
            forge.game.GameEntity d = cb.getDefenderByAttacker(att);
            boolean atYou = d instanceof forge.game.player.Player p ? p.getId() == seat
                : d instanceof Card dc && dc.getController() != null && dc.getController().getId() == seat;
            if (atYou && forge.game.combat.CombatUtil.canBlock(att, blocker, cb)) return true;
        }
        return false;
    }

    /** Ids of the attackers coming at you (or your planeswalkers) that this creature may legally block. */
    private JsonArray blockableAttackers(Card blocker) {
        JsonArray out = new JsonArray();
        forge.game.combat.Combat cb = game.getCombat();
        if (cb == null) return out;
        int seat = gui.seat().getId();
        for (Card att : cb.getAttackers()) {
            forge.game.GameEntity d = cb.getDefenderByAttacker(att);
            boolean atYou = d instanceof forge.game.player.Player p ? p.getId() == seat
                : d instanceof Card dc && dc.getController() != null && dc.getController().getId() == seat;
            if (atYou && forge.game.combat.CombatUtil.canBlock(att, blocker, cb)) out.add(att.getId());
        }
        return out;
    }

    private void combatOptions(CardView c, JsonObject o) {
        if ((!attackStep && !blockStep) || game == null || gui.seat() == null) return;
        if (c.getZone() != ZoneType.Battlefield || c.getController() == null || c.getController().getId() != gui.seat().getId()) return;
        try {
            Card real = game.findById(c.getId());
            if (real == null || !real.isCreature()) return;
            if (attackStep) {
                boolean can = forge.game.combat.CombatUtil.canAttack(real);
                o.addProperty("canAttack", can);
                // Goad / "attacks each combat if able": Forge rejects any declaration
                // that leaves these out ("Attack declaration invalid") without saying why.
                forge.game.combat.AttackRequirement req = can ? attackRequirements().get(real) : null;
                if (req != null && req.hasRequirement()) o.addProperty("mustAttack", true);
                if (real.isGoaded()) {
                    StringBuilder by = new StringBuilder();
                    for (forge.game.player.Player p : real.getGoaded()) by.append(by.length() > 0 ? ", " : "").append(p.getName());
                    o.addProperty("goadedBy", by.toString());
                }
            }
            if (blockStep) {
                o.addProperty("canBlock", canBlockAnAttacker(real));
                // Exactly which attackers it may block, so ATLIS can explain an
                // illegal pairing (a flier, shadow…) instead of just being refused.
                o.add("blocks", blockableAttackers(real));
            }
        } catch (RuntimeException ignored) {
            // advisory only; Forge still validates the click
        }
    }

    /** Exact printing, so ATLIS can show the right set's art: Forge set code + collector number. */
    /**
     * Forge only lights mana abilities while a cost is being paid, so a
     * permanent like Vivi Ornitier ({0}: add mana, once a turn) never glowed
     * at priority. Glow a non-land permanent of the seat's when it has a mana
     * ability usable right now that doesn't tap it — tapping lands and rocks
     * stay quiet, they'd light up the whole board.
     */
    private boolean freeManaReady(CardView v) {
        if (game == null || gui.seat() == null || v.getController() == null || v.getController().getId() != gui.seat().getId()) return false;
        if (v.getZone() != ZoneType.Battlefield || v.getCurrentState().isLand()) return false;
        try {
            Card real = game.findById(v.getId());
            if (real == null) return false;
            forge.game.player.Player me = real.getController();
            for (forge.game.spellability.SpellAbility sa : real.getManaAbilities()) {
                if (sa.getPayCosts() != null && sa.getPayCosts().hasTapCost()) continue;
                sa.setActivatingPlayer(me);
                if (sa.canPlay()) return true;
            }
        } catch (RuntimeException ignored) { }
        return false;
    }

    private void printing(CardView c, JsonObject o) {
        if (game == null) return;
        try {
            Card real = game.findById(c.getId());
            IPaperCard pc = real == null ? null : real.getPaperCard();
            if (pc instanceof PaperCard paper) {
                o.addProperty("set", paper.getEdition());
                o.addProperty("cn", paper.getCollectorNumber());
            } else if (real != null) {
                o.addProperty("set", real.getSetCode());
            }
        } catch (RuntimeException ignored) {
            // printing is cosmetic; never let it break a snapshot
        }
    }

    /**
     * Forge's own game log — what resolved, what moved where, who took damage —
     * so the player can always check what happened. Phase changes are left
     * out (the table shows those); newest entries last, capped.
     */
    private static JsonArray log(GameView gv) {
        JsonArray a = new JsonArray();
        try {
            forge.game.GameLog gl = gv.getGameLog();
            if (gl == null) return a;
            java.util.List<forge.game.GameLogEntry> all = new java.util.ArrayList<>(gl.getAllEntries());
            java.util.List<JsonObject> kept = new java.util.ArrayList<>();
            int seq = 0;
            for (forge.game.GameLogEntry e : all) {
                seq++;
                if (e.type() == forge.game.GameLogEntryType.PHASE) continue;
                JsonObject o = new JsonObject();
                // Stable position in the whole game's log: the window below is
                // capped, so "what's new since X" must compare these, not indexes.
                o.addProperty("n", seq);
                o.addProperty("type", e.type().name());
                o.addProperty("text", e.message());
                if (e.sourceCard() != null) o.addProperty("card", e.sourceCard().getId());
                kept.add(o);
            }
            for (JsonObject o : kept.subList(Math.max(0, kept.size() - 80), kept.size())) a.add(o);
        } catch (RuntimeException ignored) {
            // the log is a convenience; never fail a snapshot over it
        }
        return a;
    }

    private JsonObject stackItem(StackItemView si) {
        JsonObject o = new JsonObject();
        o.addProperty("id", si.getId());
        o.addProperty("text", si.getText());
        o.addProperty("trigger", si.isTrigger());
        o.addProperty("ability", si.isAbility());
        CardView src = si.getSourceCard();
        if (src != null) { o.addProperty("source", src.getId()); card(src); }
        o.addProperty("controller", si.getActivatingPlayer() == null ? null : si.getActivatingPlayer().getId());
        JsonArray tc = new JsonArray();
        for (CardView c : nn(si.getTargetCards())) { tc.add(c.getId()); card(c); }
        JsonArray tp = new JsonArray();
        for (PlayerView p : nn(si.getTargetPlayers())) tp.add(p.getId());
        o.add("targetCards", tc);
        o.add("targetPlayers", tp);
        return o;
    }

    private JsonArray combat(CombatView cv) {
        // The view's combat only refreshes when the desktop client redraws, so
        // blocks you assign mid-declaration never showed. Read the live combat.
        if (game != null) {
            try {
                forge.game.combat.Combat live = game.getCombat();
                if (live != null) return liveCombat(live);
            } catch (RuntimeException ignored) {
                // fall back to the view
            }
        }
        JsonArray a = new JsonArray();
        if (cv == null) return a;
        for (CardView att : nn(cv.getAttackers())) {
            JsonObject o = new JsonObject();
            o.addProperty("attacker", att.getId());
            card(att);
            GameEntityView def = cv.getDefender(att);
            if (def != null) {
                o.addProperty("defender", def.getId());
                o.addProperty("defenderIsPlayer", def instanceof PlayerView);
            }
            JsonArray bl = new JsonArray();
            for (CardView b : nn(cv.getBlockers(att))) { bl.add(b.getId()); card(b); }
            o.add("blockers", bl);
            a.add(o);
        }
        return a;
    }

    private JsonArray liveCombat(forge.game.combat.Combat cb) {
        JsonArray a = new JsonArray();
        for (Card att : cb.getAttackers()) {
            JsonObject o = new JsonObject();
            o.addProperty("attacker", att.getId());
            card(att.getView());
            forge.game.GameEntity def = cb.getDefenderByAttacker(att);
            if (def != null) {
                o.addProperty("defender", def.getId());
                o.addProperty("defenderIsPlayer", def instanceof forge.game.player.Player);
            }
            JsonArray bl = new JsonArray();
            for (Card b : cb.getBlockers(att)) { bl.add(b.getId()); card(b.getView()); }
            o.add("blockers", bl);
            a.add(o);
        }
        return a;
    }

    private static JsonObject counters(GameEntityView e) {
        JsonObject o = new JsonObject();
        try {
            if (e.getCounters() == null) return o;
            for (CounterType t : e.getCounters().elementSet()) o.addProperty(t.toString(), e.getCounters(t));
        } catch (RuntimeException ignored) {
            // counters are optional detail
        }
        return o;
    }

    private static <T> Iterable<T> nn(Iterable<T> it) {
        return it == null ? java.util.Collections.emptyList() : it;
    }
}
