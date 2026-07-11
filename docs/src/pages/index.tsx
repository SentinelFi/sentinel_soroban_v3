import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <img
          src={useBaseUrl('/img/sentinelBanner.png')}
          alt="Sentinel Insurance Framework"
          className={styles.heroImage}
        />
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/intro">
            Get Started
          </Link>
          <Link
            className="button button--secondary button--outline button--lg"
            to="/docs/contracts/overview">
            Smart Contracts
          </Link>
        </div>
      </div>
    </header>
  );
}

type FeatureItem = {
  title: string;
  description: string;
};

const features: FeatureItem[] = [
  {
    title: 'Automatic Payouts',
    description:
      'Parametric coverage with no claims adjusters. When a flight is delayed or ' +
      'cancelled beyond the agreed threshold, the payout becomes claimable on-chain.',
  },
  {
    title: 'Yield for Underwriters',
    description:
      'Liquidity providers deposit USDC into the Risk Vault and receive vault shares. ' +
      'Premiums from on-time flights accrue to the vault as yield.',
  },
  {
    title: 'Built on Stellar',
    description:
      'Soroban smart contracts written in Rust, with oracle data delivered by ' +
      'off-chain executors. Always solvent by design: coverage is only sold when ' +
      'capital fully backs the payout.',
  },
];

function Feature({title, description}: FeatureItem) {
  return (
    <div className="col col--4">
      <div className="text--center padding-horiz--md padding-vert--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Sentinel is a decentralized parametric insurance framework on Stellar Soroban. Flight delay coverage with automatic payouts and on-chain underwriting.">
      <HomepageHeader />
      <main>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              {features.map((props, idx) => (
                <Feature key={idx} {...props} />
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
