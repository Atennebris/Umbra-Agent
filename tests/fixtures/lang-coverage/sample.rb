require 'json'
require 'net/http'

module Umbra
  class DaemonClient
    attr_reader :host, :port

    def initialize(host, port)
      @host = host
      @port = port
    end

    def send_request(payload)
      uri = URI("http://#{@host}:#{@port}/run")
      Net::HTTP.post(uri, payload.to_json)
    end

    def self.default
      new('127.0.0.1', 4200)
    end
  end

  module Config
    def self.load(path)
      JSON.parse(File.read(path))
    end
  end
end
