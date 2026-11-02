// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

package atlis.bridge;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import forge.LobbyPlayer;
import forge.card.MagicColor;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.GameView;
import forge.game.card.CardView;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.gamemodes.match.AbstractGuiGame;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.trackable.TrackableCollection;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;

/**
 * Forge's screen interface, implemented as a JSON stream.
 *
 * Two kinds of traffic leave here:
 *  - "state": a full snapshot of the table, debounced so a burst of engine
 *    updates (a wrath, a combat damage step) becomes one message;
 *  - "request": a question the engine is blocked on (choose targets, order
 *    triggers, confirm an optional cost), answered by ATLIS.
 *
 * Nothing here decides legality. Forge's own inputs choose what is
 * selectable and what a click means; this class only reports and relays.
 */
public final class BridgeGui extends AbstractGuiGame {
    private static final ScheduledExecutorService DEBOUNCE = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "atlis-snapshot");
        t.setDaemon(true);
        return t;
    });

    private final AtomicBoolean dirty = new AtomicBoolean(false);
    private volatile PlayerView seat;

    // Prompt bar state, as Forge's current Input set it.
    private volatile String promptMessage = "";
    private volatile Integer promptCard;
    private volatile String okLabel = "OK", cancelLabel = "Cancel";
    private volatile boolean okEnabled, cancelEnabled;

    /** Phases where the human wants to stop and get priority with an empty stack. */
    // Declare-attackers must be a stop: Forge skips your combat entirely when it isn't.
    private volatile Set<PhaseType> ownStops = EnumSet.of(PhaseType.MAIN1, PhaseType.COMBAT_DECLARE_ATTACKERS, PhaseType.MAIN2);
    private volatile Set<PhaseType> otherStops = EnumSet.of(PhaseType.END_OF_TURN);

    PlayerView seat() { return seat; }

    void setStops(Set<PhaseType> own, Set<PhaseType> other) {
        ownStops = own.isEmpty() ? EnumSet.noneOf(PhaseType.class) : EnumSet.copyOf(own);
        otherStops = other.isEmpty() ? EnumSet.noneOf(PhaseType.class) : EnumSet.copyOf(other);
    }

    JsonObject promptJson() {
        JsonObject p = new JsonObject();
        p.addProperty("message", promptMessage);
        p.addProperty("card", promptCard);
        p.addProperty("okLabel", okLabel);
        p.addProperty("cancelLabel", cancelLabel);
        p.addProperty("okEnabled", okEnabled);
        p.addProperty("cancelEnabled", cancelEnabled);
        p.addProperty("min", getSelectionMin());
        p.addProperty("max", getSelectionMax());
        return p;
    }

    // ------------------------------------------------------------ snapshots

    /** Coalesce engine updates: one snapshot per 40ms burst. */
    void markDirty() {
        if (dirty.compareAndSet(false, true)) DEBOUNCE.schedule(this::flush, 40, TimeUnit.MILLISECONDS);
    }

    void flush() {
        dirty.set(false);
        GameView gv = getGameView();
        if (gv == null) return;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                Protocol.send(new Snapshot(this, Main.game()).build(gv));
                return;
            } catch (RuntimeException e) {
                // The engine thread mutates views while we read them; a retry
                // a moment later sees a settled state.
                if (attempt == 2) Protocol.error("snapshot failed", e);
                try { Thread.sleep(15); } catch (InterruptedException ie) { return; }
            }
        }
    }

    @Override public void setGameView(GameView gameView) { super.setGameView(gameView); markDirty(); }
    @Override protected void updateCurrentPlayer(PlayerView player) { markDirty(); }
    @Override public void openView(TrackableCollection<PlayerView> myPlayers) {
        if (myPlayers != null && !myPlayers.isEmpty()) seat = myPlayers.iterator().next();
        markDirty();
    }
    @Override public void updatePhase(boolean saveState) { markDirty(); }
    @Override public void updateTurn(PlayerView player) { markDirty(); }
    @Override public void updateStack() { markDirty(); }
    @Override public void updateZones(Iterable<forge.player.PlayerZoneUpdate> zonesToUpdate) { markDirty(); }
    @Override public void updateCards(Iterable<CardView> cards) { markDirty(); }
    @Override public void updateLives(Iterable<PlayerView> live) { markDirty(); }
    @Override public void updateManaPool(Iterable<PlayerView> manaPoolUpdate) { markDirty(); }
    @Override public void refreshField() { markDirty(); }
    @Override public void showCombat() { markDirty(); }
    @Override public void setSelectables(Iterable<CardView> cards, int min, int max) { super.setSelectables(cards, min, max); markDirty(); }
    @Override public void clearSelectables() { super.clearSelectables(); markDirty(); }
    @Override public void setWeaklySelectable(Iterable<CardView> cards) { super.setWeaklySelectable(cards); markDirty(); }
    @Override public void clearWeaklySelectable() { super.clearWeaklySelectable(); markDirty(); }
    @Override public void setHighlighted(Iterable<GameEntityView> entities, boolean highlight) { super.setHighlighted(entities, highlight); markDirty(); }

    // ------------------------------------------------------------ prompt bar

    @Override public void showPromptMessage(PlayerView playerView, String message, CardView card) {
        promptMessage = message == null ? "" : message;
        promptCard = card == null ? null : card.getId();
        markDirty();
    }

    @Override public void updateButtons(PlayerView owner, String label1, String label2, boolean enable1, boolean enable2, boolean focus1) {
        okLabel = label1;
        cancelLabel = label2;
        okEnabled = enable1;
        cancelEnabled = enable2;
        markDirty();
    }

    @Override public boolean isUiSetToSkipPhase(PlayerView playerTurn, PhaseType phase) {
        boolean mine = seat != null && playerTurn != null && playerTurn.getId() == seat.getId();
        return !(mine ? ownStops : otherStops).contains(phase);
    }

    // ------------------------------------------------------------ notices

    @Override public void flashIncorrectAction() { Protocol.event("invalid", null); }
    @Override public void alertUser() { }
    @Override public void message(String message, String title) { notice(title, message); }
    @Override public void showErrorDialog(String message, String title) { notice(title, message); }
    @Override public void finishGame() {
        flush();
        Protocol.event("gameOver", null);
    }
    @Override public void setCard(CardView card) { }
    @Override public void setPanelSelection(CardView hostCard) { }
    @Override public void setPlayerAvatar(LobbyPlayer player, forge.game.player.IHasIcon ihi) { }

    private static void notice(String title, String message) {
        JsonObject o = new JsonObject();
        o.addProperty("title", title);
        o.addProperty("message", message);
        Protocol.event("message", o);
    }

    // ------------------------------------------------------------ questions (block until answered)

    /** Encode a list of options; each carries a label and, when it is a game object, its id. */
    private <T> JsonArray options(List<T> items, FSerializableFunction<T, String> display) {
        JsonArray a = new JsonArray();
        for (int i = 0; i < items.size(); i++) {
            T t = items.get(i);
            JsonObject o = new JsonObject();
            o.addProperty("i", i);
            o.addProperty("label", display != null ? display.apply(t) : String.valueOf(t));
            if (t instanceof CardView c) {
                o.addProperty("card", c.getId());
                o.addProperty("label", c.getName());
                // Library/graveyard cards aren't in the table snapshot; send them with the question.
                o.add("cardData", Snapshot.optionCard(this, Main.game(), c));
            }
            else if (t instanceof PlayerView p) { o.addProperty("player", p.getId()); o.addProperty("label", p.getName()); }
            else if (t instanceof SpellAbilityView sa) {
                o.addProperty("label", sa.getDescription());
                o.addProperty("canPlay", sa.canPlay());
                if (sa.getHostCard() != null) o.addProperty("card", sa.getHostCard().getId());
            }
            a.add(o);
        }
        return a;
    }

    /** Indices chosen by ATLIS, clamped to legal bounds; falls back to the first `min` items. */
    private static <T> List<T> picked(JsonElement answer, List<T> items, int min, int max) {
        List<T> out = new ArrayList<>();
        if (answer != null && answer.isJsonArray()) {
            for (JsonElement e : answer.getAsJsonArray()) {
                int i = e.getAsInt();
                if (i >= 0 && i < items.size() && !out.contains(items.get(i)) && out.size() < max) out.add(items.get(i));
            }
        }
        for (int i = 0; out.size() < min && i < items.size(); i++) if (!out.contains(items.get(i))) out.add(items.get(i));
        return out;
    }

    private static JsonObject ask(String title, int min, int max) {
        JsonObject o = new JsonObject();
        o.addProperty("title", title);
        o.addProperty("min", min);
        o.addProperty("max", max);
        return o;
    }

    @Override
    public <T> List<T> getChoices(String message, int min, int max, List<T> choices, List<T> selected, FSerializableFunction<T, String> display) {
        if (choices == null || choices.isEmpty()) return new ArrayList<>();
        JsonObject q = ask(message, min, max);
        q.add("options", options(choices, display));
        return picked(Protocol.request("choose", q), choices, min, max);
    }

    @Override
    public boolean confirm(CardView c, String question, boolean defaultIsYes, List<String> options) {
        JsonObject q = ask(question, 1, 1);
        if (c != null) q.addProperty("card", c.getId());
        List<String> opts = options == null || options.isEmpty() ? List.of("Yes", "No") : options;
        q.add("options", options(opts, null));
        q.addProperty("default", defaultIsYes ? 0 : 1);
        JsonElement a = Protocol.request("confirm", q);
        if (a == null || !a.isJsonPrimitive()) return defaultIsYes;
        return a.getAsInt() == 0;
    }

    @Override
    public boolean showConfirmDialog(String message, String title, String yesButtonText, String noButtonText, boolean defaultYes) {
        return confirm(null, title == null || title.isEmpty() ? message : title + ": " + message, defaultYes, List.of(yesButtonText, noButtonText));
    }

    @Override
    public int showOptionDialog(String message, String title, FSkinProp icon, List<String> options, int defaultOption) {
        JsonObject q = ask(title == null || title.isEmpty() ? message : title + ": " + message, 1, 1);
        q.add("options", options(options, null));
        q.addProperty("default", defaultOption);
        JsonElement a = Protocol.request("option", q);
        return a == null || !a.isJsonPrimitive() ? defaultOption : a.getAsInt();
    }

    @Override
    public String showInputDialog(String message, String title, FSkinProp icon, String initialInput, List<String> inputOptions, boolean isNumeric) {
        JsonObject q = ask(title == null || title.isEmpty() ? message : title + ": " + message, 1, 1);
        q.addProperty("initial", initialInput);
        q.addProperty("numeric", isNumeric);
        if (inputOptions != null) q.add("options", options(inputOptions, null));
        JsonElement a = Protocol.request("input", q);
        return a == null || a.isJsonNull() ? initialInput : a.getAsString();
    }

    @Override
    public GameEntityView chooseSingleEntityForEffect(String title, List<? extends GameEntityView> optionList, DelayedReveal delayedReveal, boolean isOptional) {
        if (optionList == null || optionList.isEmpty()) return null;
        List<GameEntityView> items = new ArrayList<>(optionList);
        List<GameEntityView> r = getChoices(title, isOptional ? 0 : 1, 1, items, null, null);
        return r.isEmpty() ? null : r.get(0);
    }

    @Override
    public List<GameEntityView> chooseEntitiesForEffect(String title, List<? extends GameEntityView> optionList, int min, int max, DelayedReveal delayedReveal) {
        if (optionList == null || optionList.isEmpty()) return new ArrayList<>();
        return getChoices(title, min, max, new ArrayList<GameEntityView>(optionList), null, null);
    }

    @Override
    public SpellAbilityView getAbilityToPlay(CardView hostCard, List<SpellAbilityView> abilities, ITriggerEvent triggerEvent) {
        if (abilities == null || abilities.isEmpty()) return null;
        // Mirrors Forge's desktop client (CMatchUI.getAbilityToPlay) exactly.
        //
        // No trigger event = the ENGINE is asking, not a click: putting a
        // triggered ability on the stack, or picking a cost variant. A lone
        // ability is simply it — a trigger is never "playable" in the
        // castable-now sense, and filtering on canPlay() here silently
        // declined every trigger the human controlled.
        if (triggerEvent == null) {
            if (abilities.size() == 1) return abilities.get(0);
            JsonObject q = ask("Choose an ability of " + hostCard.getName(), 0, 1);
            q.addProperty("card", hostCard.getId());
            q.add("options", options(abilities, null));
            List<SpellAbilityView> r = picked(Protocol.request("ability", q), abilities, 0, 1);
            return r.isEmpty() ? null : r.get(0);
        }
        // A click on a card: only what can be played now.
        if (abilities.size() == 1 && !abilities.get(0).promptIfOnlyPossibleAbility()) {
            return abilities.get(0).canPlay() ? abilities.get(0) : null;
        }
        List<SpellAbilityView> playable = new ArrayList<>();
        for (SpellAbilityView sa : abilities) if (sa.canPlay()) playable.add(sa);
        if (playable.isEmpty()) return null;
        JsonObject q = ask("Choose an ability of " + hostCard.getName(), 0, 1);
        q.addProperty("card", hostCard.getId());
        q.add("options", options(playable, null));
        List<SpellAbilityView> r = picked(Protocol.request("ability", q), playable, 0, 1);
        return r.isEmpty() ? null : r.get(0);
    }

    @Override
    public <T> OrderResult<T> order(String title, String top, int remainingObjectsMin, int remainingObjectsMax, List<T> sourceChoices, List<T> destChoices, CardView referenceCard, boolean sideboardingMode, boolean showRememberCheckbox) {
        JsonObject q = ask(title, sourceChoices.size(), sourceChoices.size());
        q.addProperty("top", top);
        q.add("options", options(sourceChoices, null));
        JsonElement a = Protocol.request("order", q);
        List<T> ordered = picked(a, sourceChoices, sourceChoices.size(), sourceChoices.size());
        if (destChoices != null) ordered.addAll(destChoices);
        return new OrderResult<>(ordered, false);
    }

    @Override
    public List<CardView> manipulateCardList(String title, Iterable<CardView> cards, Iterable<CardView> manipulable, boolean toTop, boolean toBottom, boolean toAnywhere) {
        List<CardView> all = new ArrayList<>();
        cards.forEach(all::add);
        JsonObject q = ask(title, all.size(), all.size());
        q.add("options", options(all, null));
        return picked(Protocol.request("order", q), all, all.size(), all.size());
    }

    /**
     * Combat damage assignment. Phase 0 answers it the way the rules default
     * does — lethal damage to each blocker in order, the rest to the last
     * (or, with trample handled by Forge's own validation, the player). A
     * proper assignment dialog lands with the table UI.
     */
    @Override
    public Map<CardView, Integer> assignCombatDamage(CardView attacker, List<CardView> blockers, int damage, GameEntityView defender, boolean overrideOrder, boolean maySkip) {
        Map<CardView, Integer> out = new HashMap<>();
        int left = damage;
        for (int i = 0; i < blockers.size(); i++) {
            CardView b = blockers.get(i);
            int lethal = Math.max(0, b.getLethalDamage());
            int give = i == blockers.size() - 1 ? left : Math.min(left, lethal);
            if (give > 0) out.put(b, give);
            left -= give;
        }
        if (left > 0 && defender instanceof CardView dc) out.merge(dc, left, Integer::sum);
        return out;
    }

    /**
     * "Divide X among these": Vivi's {U}/{R} split, "X damage divided as you
     * choose", counters spread across creatures. ATLIS asks with steppers; an
     * answer that doesn't add up (or none) falls back to an even split.
     */
    @Override
    public Map<Object, Integer> assignGenericAmount(CardView effectSource, Map<Object, Integer> target, int amount, boolean atLeastOne, String amountLabel) {
        List<Object> keys = new ArrayList<>(target.keySet());
        if (keys.isEmpty()) return new HashMap<>();
        String what = amountLabel == null || amountLabel.isEmpty() ? "" : " " + amountLabel;
        JsonObject q = ask("Divide " + amount + what + (effectSource != null ? " — " + effectSource.getName() : ""), 0, amount);
        if (effectSource != null) q.addProperty("card", effectSource.getId());
        q.addProperty("amount", amount);
        q.addProperty("atLeastOne", atLeastOne);
        q.addProperty("unit", amountLabel == null ? "" : amountLabel);
        JsonArray opts = options(keys, (Object k) -> k instanceof MagicColor.Color c ? colorName(c) : String.valueOf(k));
        for (int i = 0; i < keys.size(); i++) {
            JsonObject o = opts.get(i).getAsJsonObject();
            Integer cap = target.get(keys.get(i));
            o.addProperty("max", cap == null ? amount : Math.min(cap, amount));
            if (keys.get(i) instanceof MagicColor.Color c) o.addProperty("color", colorCode(c));
        }
        q.add("options", opts);
        JsonElement a = Protocol.request("assign", q);

        Map<Object, Integer> out = new HashMap<>();
        if (a != null && a.isJsonArray() && a.getAsJsonArray().size() == keys.size()) {
            int sum = 0;
            boolean ok = true;
            for (int i = 0; i < keys.size(); i++) {
                int n = a.getAsJsonArray().get(i).getAsInt();
                Integer cap = target.get(keys.get(i));
                if (n < 0 || (cap != null && n > cap) || (atLeastOne && n < 1)) ok = false;
                sum += n;
                if (n > 0) out.put(keys.get(i), n);
            }
            if (ok && sum == amount) return out;
            out.clear();
        }
        int each = amount / keys.size();
        for (Object k : keys) out.put(k, each);
        out.merge(keys.get(0), amount - each * keys.size(), Integer::sum);
        return out;
    }

    private static String colorName(MagicColor.Color c) {
        String n = c.name().toLowerCase();
        return Character.toUpperCase(n.charAt(0)) + n.substring(1);
    }

    private static String colorCode(MagicColor.Color c) {
        return switch (c) {
            case WHITE -> "W";
            case BLUE -> "U";
            case BLACK -> "B";
            case RED -> "R";
            case GREEN -> "G";
            default -> "C";
        };
    }

    /**
     * "Look at these" — an opponent reveals cards, or Forge's pre-game notice
     * that the AI can't play some cards well. Informational: nothing to
     * choose, so it must not block the game behind a dialog.
     */
    @Override
    public <T> void reveal(String message, List<T> items) {
        JsonObject o = new JsonObject();
        o.addProperty("title", message);
        o.add("options", options(items == null ? List.of() : items, null));
        Protocol.event("reveal", o);
    }

    @Override public List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message) { return new ArrayList<>(); }

    @Override public forge.game.GameState getGamestate() { return null; }
}
