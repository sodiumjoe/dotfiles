local stripe = require("sodium.config.stripe")

describe("build_sg_url", function()
    local home = vim.fn.expand("~")
    local local_dir = home .. "/stripe/"

    it("generates URL for normal repo", function()
        local url = stripe.build_sg_url(local_dir, home .. "/stripe/pay-server/config/foo.yaml", 5)
        assert.are.equal(
            "https://stripe.sourcegraphcloud.com/git.corp.stripe.com/stripe-internal/pay-server/-/blob/config/foo.yaml?L5",
            url
        )
    end)

    it("generates URL for mint monorepo subdirectory", function()
        local url = stripe.build_sg_url(local_dir, home .. "/stripe/mint/pay-server/config/foo.yaml", 11)
        assert.are.equal(
            "https://stripe.sourcegraphcloud.com/git.corp.stripe.com/stripe-internal/pay-server/-/blob/config/foo.yaml?L11",
            url
        )
    end)

    it("generates URL for mint monorepo via remote path", function()
        local url = stripe.build_sg_url("/pay/src/", "/pay/src/mint/zoolander/app/foo.rb", 3)
        assert.are.equal(
            "https://stripe.sourcegraphcloud.com/git.corp.stripe.com/stripe-internal/zoolander/-/blob/app/foo.rb?L3",
            url
        )
    end)

    it("returns nil for path outside stripe", function()
        local url = stripe.build_sg_url(local_dir, "/tmp/foo.lua", 1)
        assert.is_nil(url)
    end)

    it("returns nil when stripe_dir is nil", function()
        local url = stripe.build_sg_url(nil, home .. "/stripe/pay-server/foo.lua", 1)
        assert.is_nil(url)
    end)

    it("handles file at mint root without sub-repo", function()
        local url = stripe.build_sg_url(local_dir, home .. "/stripe/mint/README.md", 1)
        assert.are.equal(
            "https://stripe.sourcegraphcloud.com/git.corp.stripe.com/stripe-internal/mint/-/blob/README.md?L1",
            url
        )
    end)
end)