package.path = vim.env.DOTFILES_TEST_ROOT .. "/tests/neovim/?.lua;" .. package.path
local operations = require("sodium.agency.operations")
describe("Agency Git result controls", function()
    local function proposal()
        return { proposalId = string.rep("a", 64), destination = { cwd = "/destination", ref = "refs/heads/main", head = string.rep("b", 40) },
            baseOid = string.rep("c", 40), resultOid = string.rep("d", 40), tree = string.rep("e", 40),
            remoteUrl = "/remote.git", sourceOids = { string.rep("d", 40) }, linear = true, diffSummary = "first.txt | 1 +",
            issues = {}, claimedValidations = { { argv = { "sh", "-c", "worker claim" }, result = "claimed", exitCode = 0 } },
            validations = { { argv = { "node", "--test" }, result = "validated", exitCode = 0 } } }
    end
    it("previews immutable source, destination and claims separately from actual validation", function()
        local lines = operations.git_preview(proposal(), "merge")
        local text = table.concat(lines, "\n")
        assert.is_truthy(text:find("Destination: /destination", 1, true))
        assert.is_truthy(text:find("Destination HEAD: " .. string.rep("b", 40), 1, true))
        assert.is_truthy(text:find("Result OID: " .. string.rep("d", 40), 1, true))
        assert.is_truthy(text:find("Worker validation claims", 1, true))
        assert.is_truthy(text:find("Configured validation results", 1, true))
    end)
    it("uses explicit confirmed strategy and stable IDs without changing the editor layout", function()
        local calls, choose, confirm, result = {}, nil, nil, nil
        local api = operations.new({ uuid = function() return "00000000-0000-4000-8000-000000000001" end,
            client = { command = function(argv, _, cb) calls[#calls + 1] = { argv = argv, cb = cb } end },
            select_git_strategy = function(_, cb) choose = cb end, confirm_git = function(_, _, cb) confirm = cb end })
        local layout = vim.fn.winlayout()
        api.verify_result("00000000-0000-4000-8000-000000000002", "/destination", function(err, value) assert.is_nil(err); result = value end)
        calls[1].cb(nil, { result = proposal() }); choose("cherry-pick")
        assert.are.equal(1, #calls); confirm(true)
        assert.are.same({ "git", "integrate", string.rep("a", 64), "--command-id", "00000000-0000-4000-8000-000000000001",
            "--expected-head", string.rep("b", 40), "--strategy", "cherry-pick" }, calls[2].argv)
        calls[2].cb(nil, { result = { state = "integrated" } })
        assert.are.equal("integrated", result.state); assert.are.same(layout, vim.fn.winlayout())
    end)
    it("keeps rejected proposals visible and never dispatches integration", function()
        local count, result = 0, nil
        local api = operations.new({ client = { command = function(_, _, cb) count = count + 1; local p = proposal(); p.issues = { "GIT_FETCH_FAILED" }; cb(nil, { result = p }) end } })
        api.verify_result("00000000-0000-4000-8000-000000000002", "/destination", function(err, value) result = value; assert.are.equal("GIT_PROPOSAL_REJECTED", err.code) end)
        assert.are.equal(1, count); assert.are.same({ "GIT_FETCH_FAILED" }, result.issues)
    end)
end)