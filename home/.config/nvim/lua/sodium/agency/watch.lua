local M = {}
local function valid_id(value)
    return type(value) == "string" and value == value:lower()
        and value:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$")
end
function M.new(deps)
    deps = deps or {}
    local system, schedule, defer = deps.system or vim.system, deps.schedule or vim.schedule, deps.defer or vim.defer_fn
    local api, epoch, closed, job, retry = {}, 0, false, nil, nil
    function api.start(argv, update, unavailable)
        assert(not closed and not job)
        local launch
        launch = function()
            if closed then return end
            epoch = epoch + 1
            local token, active, buffer, generation, seq, queued = epoch, true, "", nil, 0, 0
            local function live() return not closed and active and epoch == token end
            local function fail(code)
                if not live() then return end
                active = false
                if job then pcall(job.kill, job, 15); job = nil end
                schedule(function() if not closed and epoch == token then unavailable(code) end end)
                retry = defer(function() retry = nil; if not closed and epoch == token then launch() end end, 500)
            end
            local args = { deps.executable or "agy" }
            vim.list_extend(args, argv); args[#args + 1] = "--json"
            local ok, handle = pcall(system, args, { text = false, stderr = function() end,
                stdout = function(err, chunk)
                    if not live() then return end
                    if err then fail("BUREAU_UNAVAILABLE"); return end
                    if not chunk then return end
                    buffer = buffer .. chunk
                    while live() do
                        local ending = buffer:find("\n", 1, true)
                        if not ending then break end
                        if ending > 8388608 then fail("INVALID_PROTOCOL"); return end
                        local raw = buffer:sub(1, ending - 1)
                        buffer = buffer:sub(ending + 1)
                        local valid, frame = pcall(function()
                            local value = vim.json.decode(raw)
                            assert(value.protocol == "agency-bureau-watch-v1" and valid_id(value.generation))
                            assert(type(value.seq) == "number" and value.seq == seq + 1)
                            assert(generation == nil and value.seq == 1 or generation == value.generation)
                            assert(value.kind == "snapshot" and type(value.result) == "table"
                                or value.kind == "unavailable" and type(value.error) == "table" and type(value.error.code) == "string")
                            return value
                        end)
                        if not valid then fail("INVALID_PROTOCOL"); return end
                        generation, seq = frame.generation, frame.seq
                        queued = queued + #raw
                        if queued > 16777216 then fail("INVALID_PROTOCOL"); return end
                        schedule(function()
                            queued = queued - #raw
                            if not live() then return end
                            if frame.kind == "snapshot" then update(frame.result) else unavailable(frame.error.code) end
                        end)
                    end
                    if #buffer > 8388608 then fail("INVALID_PROTOCOL") end
                end }, function() fail("BUREAU_UNAVAILABLE") end)
            if not ok then fail("BUREAU_UNAVAILABLE")
            elseif live() then job = handle
            else pcall(handle.kill, handle, 15) end
        end
        launch()
    end
    function api.close()
        if closed then return end
        closed, epoch = true, epoch + 1
        if retry then pcall(retry.stop, retry); pcall(retry.close, retry); retry = nil end
        if job then pcall(job.kill, job, 15); job = nil end
    end
    return api
end
return M