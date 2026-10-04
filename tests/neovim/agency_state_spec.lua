package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local fixture = require("fixtures.agency")

local function snapshot(state, frames)
    state.begin_snapshot(frames[1], #vim.json.encode(frames[1]) + 1)
    for i = 2, #frames - 1 do
        state.add_snapshot_events(frames[i], #vim.json.encode(frames[i]) + 1)
    end
    state.end_snapshot(frames[#frames], #vim.json.encode(frames[#frames]) + 1)
end

describe("Agency bounded projection", function()
    it("undercharges neither declared bytes nor local decoded event storage", function()
        local state = require("sodium.agency.state").new({ history_bytes = 4096 })
        snapshot(state, fixture.snapshot())
        for seq = 2, 20 do
            local event = fixture.event(seq, string.rep("x", 700))
            event.encodedBytes = 1
            state.apply_event({ target = fixture.target_a, event = event, firstSeq = 1, historyTruncated = false })
        end
        assert.is_true(state.retention().bytes <= 4096)
        assert.is_true(state.retention().events < 20)
        assert.are.equal(20, state.retention().last_seq)
    end)

    it("rejects excessive event counts even when encoded bytes remain small", function()
        local state = require("sodium.agency.state").new()
        local frames = fixture.snapshot()
        frames[1].lastSeq = 8193
        state.begin_snapshot(frames[1], 100)
        local events = {}
        for seq = 1, 8192 do
            events[#events + 1] = fixture.event(seq, "")
        end
        state.add_snapshot_events(
            {
                type = "snapshot_events",
                target = fixture.target_a,
                snapshotId = fixture.id(100),
                chunkIndex = 0,
                events = events,
            },
            100
        )
        assert.has_error(function()
            state.add_snapshot_events(
                {
                    type = "snapshot_events",
                    target = fixture.target_a,
                    snapshotId = fixture.id(100),
                    chunkIndex = 1,
                    events = { fixture.event(8193, "") },
                },
                100
            )
        end)
    end)
    it("keeps terminal turn identity consistent with a later snapshot", function()
        local state = require("sodium.agency.state").new()
        snapshot(state, fixture.snapshot())
        state.apply_event({
            target = fixture.target_a,
            event = {
                kind = "turn",
                seq = 2,
                encodedBytes = 200,
                submissionId = fixture.id(601),
                state = "completed",
                stopReason = "end_turn",
                failure = vim.NIL,
            },
            firstSeq = 1,
            historyTruncated = false,
        })
        assert.are.same({ submissionId = fixture.id(601), state = "completed" }, state.current().currentTurn)
    end)

    it("evicts an advanced Handler boundary even on an identical duplicate", function()
        local state = require("sodium.agency.state").new()
        snapshot(state, fixture.snapshot())
        state.apply_event({
            target = fixture.target_a,
            event = fixture.event(2),
            firstSeq = 1,
            historyTruncated = false,
        })
        local result = state.apply_event({
            target = fixture.target_a,
            event = fixture.event(2),
            firstSeq = 2,
            historyTruncated = true,
        })
        assert.is_false(result.appended)
        assert.are.equal(2, state.retention().first_seq)
        assert.are.equal(1, result.evicted)
    end)

    it("does not expose mutable projection metadata to views", function()
        local state = require("sodium.agency.state").new()
        snapshot(state, fixture.snapshot())
        local copy = state.current()
        copy.target.agentId = fixture.id(999)
        copy.events[1].update.content.text = "changed"
        copy.metadata.cwd = "/other"
        assert.are.equal(fixture.target_a.agentId, state.current().target.agentId)
        assert.are.equal("answer", state.current().events[1].update.content.text)
        assert.are.equal("/work/a", state.current().metadata.cwd)
    end)

    it("rejects retention regression on identical duplicate events", function()
        local state = require("sodium.agency.state").new()
        snapshot(state, fixture.snapshot())
        state.apply_event({ target = fixture.target_a, event = fixture.event(2), firstSeq = 2, historyTruncated = true })
        assert.has_error(function()
            state.apply_event({
                target = fixture.target_a,
                event = fixture.event(2),
                firstSeq = 1,
                historyTruncated = false,
            })
        end)
    end)

    it("bounds raw staging independently of conservative event retention", function()
        local state = require("sodium.agency.state").new({ history_bytes = 100 })
        local frames = fixture.snapshot()
        frames[1].lastSeq = 8
        state.begin_snapshot(frames[1], 2097152)
        for chunk = 0, 6 do
            local item = vim.deepcopy(frames[2])
            item.chunkIndex = chunk
            item.events[1] = fixture.event(chunk + 1)
            state.add_snapshot_events(item, 2097152)
        end
        local item = vim.deepcopy(frames[2])
        item.chunkIndex = 7
        item.events[1] = fixture.event(8)
        assert.has_error(function()
            state.add_snapshot_events(item, 2097152)
        end)
    end)

    it("commits only complete snapshots and preserves a disconnected projection", function()
        local state = require("sodium.agency.state").new()
        local frames = fixture.snapshot()
        state.begin_snapshot(frames[1], 100)
        state.add_snapshot_events(frames[2], 100)
        assert.is_nil(state.current())
        state.end_snapshot(frames[3], 100)
        assert.is_true(state.current().connected)
        state.disconnect({ code = "UNAVAILABLE" })
        assert.is_false(state.current().connected)
        assert.are.equal("answer", state.current().events[1].update.content.text)
    end)

    it("bounds more than three live retention windows without resetting sequence", function()
        local state = require("sodium.agency.state").new({ history_bytes = 8192, history_events = 3 })
        snapshot(state, fixture.snapshot())
        for seq = 2, 16 do
            local result = state.apply_event({
                target = fixture.target_a,
                event = fixture.event(seq, string.rep("x", 200)),
                firstSeq = math.max(1, seq - 8),
                historyTruncated = seq > 9,
            })
            assert.is_true(result.appended)
            assert.are.equal(seq, result.last_seq)
            assert.is_true(state.retention().bytes <= 8192)
            assert.is_true(state.retention().events <= 3)
        end
        assert.are.equal(16, state.retention().last_seq)
        assert.is_true(state.retention().truncated)
        assert.are.equal(14, state.retention().first_seq)
    end)

    it("rejects missing chunks, tuple changes, gaps and conflicting duplicates", function()
        for _, mutate in ipairs({
            function(frames)
                frames[2].chunkIndex = 1
            end,
            function(frames)
                frames[2].target = fixture.target_b
            end,
            function(frames)
                frames[2].events[1].seq = 2
            end,
            function(frames)
                frames[2].events[1].encodedBytes = 0
            end,
        }) do
            local state = require("sodium.agency.state").new()
            local frames = fixture.snapshot()
            mutate(frames)
            assert.has_error(function()
                snapshot(state, frames)
            end)
        end
        local state = require("sodium.agency.state").new({ history_events = 1 })
        snapshot(state, fixture.snapshot())
        state.apply_event({
            target = fixture.target_a,
            event = fixture.event(2),
            firstSeq = 1,
            historyTruncated = false,
        })
        assert.has_error(function()
            state.apply_event({
                target = fixture.target_a,
                event = fixture.event(1),
                firstSeq = 1,
                historyTruncated = false,
            })
        end)
        assert.has_error(function()
            state.apply_event({
                target = fixture.target_a,
                event = fixture.event(2, "different"),
                firstSeq = 1,
                historyTruncated = false,
            })
        end)
    end)
end)