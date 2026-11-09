describe("Agency friendly remote names", function()
    local directory, original_path

    before_each(function()
        directory = vim.fn.tempname()
        vim.fn.mkdir(directory, "p")
        original_path = vim.env.PATH
        vim.env.PATH = directory
    end)

    after_each(function()
        vim.env.PATH = original_path
        vim.fn.delete(directory, "rf")
    end)

    local function pay(command)
        vim.fn.writefile({ "#!/bin/sh", '[ "$*" = "remote list --raw" ] || exit 64', command }, directory .. "/pay")
        assert.are.equal(1, vim.fn.setfperm(directory .. "/pay", "rwx------"))
    end

    local function lookup()
        local loaded, reader = pcall(require, "sodium.agency.remote_names")
        assert.is_true(loaded, tostring(reader))
        local names, calls, fast = nil, 0, nil
        reader.read(function(result)
            calls, names, fast = calls + 1, result, vim.in_fast_event()
        end)
        assert.is_true(vim.wait(5000, function() return names ~= nil end))
        vim.wait(100, function() return false end)
        assert.are.equal(1, calls)
        assert.is_false(fast)
        return names
    end

    it("matches friendly names to exact hosts and ignores stopped or invalid entries", function()
        pay("printf '%s' " .. vim.fn.shellescape(vim.json.encode({
            { name = "climate", host = "qa-mydev--123.northwest.stripe.io" },
            { name = "stopped", host = vim.NIL },
            { name = "wrong-host", host = "qa-mydev--123" },
            { name = "", host = "blank" },
            { name = "bad\nname", host = "control" },
        })))
        assert.are.same({ ["qa-mydev--123.northwest.stripe.io"] = "climate", ["qa-mydev--123"] = "wrong-host" }, lookup())
    end)

    it("omits conflicting names for one host without dropping other hosts", function()
        pay("printf '%s' " .. vim.fn.shellescape(vim.json.encode({
            { name = "climate", host = "worker" },
            { name = "other", host = "worker" },
            { name = "climate", host = "worker" },
            { name = "scripts", host = "worker-2" },
            { name = "scripts", host = "worker-2" },
        })))
        assert.are.same({ ["worker-2"] = "scripts" }, lookup())
    end)

    for _, stdout in ipairs({ "invalid json", '{"name":"climate","host":"worker"}' }) do
        it("falls back for malformed remote-list output " .. stdout, function()
            pay("printf '%s' " .. vim.fn.shellescape(stdout))
            assert.are.same({}, lookup())
        end)
    end

    it("falls back when the remote command fails", function()
        pay("exit 1")
        assert.are.same({}, lookup())
    end)

    it("falls back when pay is absent", function()
        assert.are.same({}, lookup())
    end)

    it("bounds a stalled remote lookup and completes once on the editor thread", function()
        pay("trap '' TERM; exec /bin/sleep 10")
        assert.are.same({}, lookup())
    end)
end)