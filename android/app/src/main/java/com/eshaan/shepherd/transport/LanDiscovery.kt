package com.eshaan.shepherd.transport

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo

/**
 * One Shepherd host seen advertising itself on the local link. A *claim*, never an identity:
 * anything on the network can publish this service, so a result only means "somewhere to try
 * pairing". Trust arrives from the host's code plus the SAS comparison, never from here.
 */
data class LanHost(val name: String, val host: String, val port: Int)

/**
 * Bonjour/mDNS discovery of `_shepherd._tcp`. Started only while the pairing screen is open —
 * a browser left running is a wakeup source, and nobody is looking at results otherwise.
 */
class LanDiscovery(context: Context) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var listener: NsdManager.DiscoveryListener? = null
    private val found = LinkedHashMap<String, LanHost>()

    fun start(onHosts: (List<LanHost>) -> Unit) {
        if (listener != null) return
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String?) {}
            override fun onDiscoveryStopped(serviceType: String?) {}
            override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) {}

            override fun onServiceFound(info: NsdServiceInfo) {
                // Resolution is what turns an advertised name into an address; the name alone
                // cannot be dialled.
                nsd.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(si: NsdServiceInfo?, errorCode: Int) {}
                    override fun onServiceResolved(si: NsdServiceInfo) {
                        val addr = si.host?.hostAddress ?: return
                        found[si.serviceName] = LanHost(si.serviceName, addr, si.port)
                        onHosts(found.values.toList())
                    }
                })
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                found.remove(info.serviceName)
                onHosts(found.values.toList())
            }
        }
        listener = l
        nsd.discoverServices("_shepherd._tcp", NsdManager.PROTOCOL_DNS_SD, l)
    }

    fun stop() {
        listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        listener = null
        found.clear()
    }
}
