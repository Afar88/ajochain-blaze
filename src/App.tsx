import { useState } from "react";
import { ArrowUpRight, CircleDollarSign, ShieldCheck, Users, Wallet, Plus, Activity, ChevronDown } from "lucide-react";
import { NETWORKS, type NetworkId } from "./core/network";

export default function App() {
  const [network, setNetwork] = useState<NetworkId>("mainnet");
  const [showNetworks, setShowNetworks] = useState(false);
  const selected = NETWORKS[network];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="AjoChain home"><span className="brand-mark">a</span><span>AjoChain</span></a>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          <a className="nav-item active" href="#overview"><Activity size={18}/> Overview</a>
          <a className="nav-item" href="#circles"><Users size={18}/> My circles</a>
          <a className="nav-item" href="#activity"><CircleDollarSign size={18}/> Transactions</a>
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><ShieldCheck size={17}/><span><b>Security first</b><small>Transactions are not enabled in this preview.</small></span></div>
          <div className="profile"><div className="avatar">A</div><span><b>Guest workspace</b><small>Wallet not connected</small></span></div>
        </div>
      </aside>

      <section className="main-panel" id="overview">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Overview</div>
          <div className="top-actions">
            <div className="network-wrap">
              <button className="network-button" onClick={() => setShowNetworks(!showNetworks)} aria-expanded={showNetworks}>
                <span className={network === "mainnet" ? "network-dot live" : "network-dot"} />
                {selected.label}<ChevronDown size={15}/>
              </button>
              {showNetworks && <div className="network-menu">
                {(["mainnet", "chipnet"] as NetworkId[]).map((id) => <button key={id} onClick={() => { setNetwork(id); setShowNetworks(false); }}>
                  <span className={id === "mainnet" ? "network-dot live" : "network-dot"}/>{NETWORKS[id].label}
                </button>)}
              </div>}
            </div>
            <button className="connect-button" disabled title="WizardConnect integration is being implemented"><Wallet size={17}/> Connect wallet</button>
          </div>
        </header>

        <div className="content">
          <div className="welcome-row">
            <div><div className="eyebrow">YOUR SAVINGS, IN SYNC</div><h1>Save together.<br/><em>Grow together.</em></h1><p className="intro">A clearer way to build savings circles with people who matter.</p></div>
            <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="hero-coin">₿</div><span className="spark spark-one">✳</span><span className="spark spark-two">·</span></div>
          </div>

          <div className="notice"><ShieldCheck size={18}/><div><b>{network === "mainnet" ? "Bitcoin Cash mainnet selected" : "Chipnet selected"} — preview mode</b><span>Network selection is informational. Wallet signing and transaction broadcast are not enabled yet.</span></div><span className="notice-tag">READ ONLY</span></div>

          <div className="section-heading"><div><h2>Your overview</h2><p>Your circles and contributions will appear here.</p></div><button className="primary-button" disabled title="Available after wallet and contract integration"><Plus size={17}/> Create a circle</button></div>

          <div className="stats-grid">
            <div className="stat-card"><div className="stat-top"><span>Total saved</span><CircleDollarSign size={18}/></div><strong>—</strong><small>Across your active circles</small></div>
            <div className="stat-card"><div className="stat-top"><span>Active circles</span><Users size={18}/></div><strong>0</strong><small>Join or create a circle to begin</small></div>
            <div className="stat-card"><div className="stat-top"><span>Next contribution</span><Activity size={18}/></div><strong>—</strong><small>Your upcoming schedule</small></div>
          </div>

          <section className="empty-card" id="circles">
            <div className="empty-icon"><Users size={23}/></div><h3>Your circles start here</h3><p>When wallet connection and circle contracts are ready, you’ll be able to create a group, invite members and track every contribution transparently.</p><button className="text-button" disabled>Circle creation is coming next <ArrowUpRight size={16}/></button>
          </section>

          <footer><span>© 2026 AjoChain</span><span><span className="footer-dot"/> Independent BCH build · {selected.label}</span></footer>
        </div>
      </section>
    </main>
  );
}