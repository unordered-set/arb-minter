import { ethers } from "ethers";
import { useEffect, useRef, useState } from "react";

const WS_SERVER = "ws://144.76.39.46:8548";
const CLAIM_CONTRACT_ADDRESS = "0x67a24CE4321aB3aF51c2D0a4801c3E111D88C9d9";
const TOKEN_ADDRESS = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const MULTICALL2_ADDRESS = "0x842eC2c7D803033Edf55E478F461FC547Bc54EB2";
const DISABLE_BLOCK_SCAN = false;
const TIPS_RECEIVER = "0x94d0A46C47c565Cad787286f8150C113f3bB48A1";

// const WS_SERVER = "ws://localhost:8545";
// const CLAIM_CONTRACT_ADDRESS = "0x59b670e9fA9D0A427751Af201D676719a970857b";
// const TOKEN_ADDRESS = "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d";

const CLAIM_CONTRACT_ABI = [
    "function claimPeriodStart() public view returns (uint256)",
    "function claimPeriodEnd() public view returns (uint256)",
    "function claimableTokens(address addr) public view returns (uint256)",
    "function claim() public",
    "event HasClaimed(address indexed recipient, uint256 amount)",
];

const ERC20_ABI = [
    "function balanceOf(address owner) public view returns (uint256)",
    "function transfer(address to, uint256 value) public returns (bool)",
]

const CURRENT_L1_BLOCK_ABI = [
    "function getL1BlockNumber() public view returns (uint256)",
]

const RPC_SERVERS = [
    "https://arbitrum.blockpi.network/v1/rpc/public",
    "https://arbitrum-one.public.blastapi.io",
    "https://endpoints.omniatech.io/v1/arbitrum/one/public",
    "https://rpc.ankr.com/arbitrum",
    "https://arb1.arbitrum.io/rpc",
    "https://1rpc.io/arb",
]

export default function Claim() {
    const provider = useRef<ethers.providers.WebSocketProvider>();
    const claimContract = useRef<ethers.Contract>();
    const arbTokenContract = useRef<ethers.Contract>();
    const claimPeriodStarted = useRef<Promise<boolean>>();

    const [blockNumber, setBlockNumber] = useState(0);
    const [blockUpdated, setBlockUpdated] = useState<Date>(new Date(2023, 2, 23));
    const [wallets, setWallets] = useState<ethers.Wallet[]>([]);
    const [destinations, setDestinations] = useState<string[]>([]);
    const [lastError, setLastError] = useState<string>();
    const [nativeBalances, setNativeBalances] = useState<ethers.BigNumber[]>([]);
    const [claimableBalances, setClaimableBalances] = useState<ethers.BigNumber[]>([]);
    const [claimPeriodStart, setClaimPeriodStart] = useState<ethers.BigNumber>();
    const [transactionStates, setTransactionStateses] = useState<number[]>([]);
    const [inputText, setInputText] = useState(``);
    const [runApproved, setRunApproved] = useState(false);
    const [tips, setTips] = useState<boolean>(true);
    const [crazyMode, setCrazyMode] = useState<boolean>(false);
    const [gasPrice, setGasPrice] = useState<string>("10");

    useEffect(() => {
        provider.current = new ethers.providers.WebSocketProvider(WS_SERVER);
        claimContract.current = new ethers.Contract(CLAIM_CONTRACT_ADDRESS, CLAIM_CONTRACT_ABI, provider.current);
        arbTokenContract.current = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, provider.current);
        claimContract.current.claimPeriodStart().then((start: ethers.BigNumber) => {
            setClaimPeriodStart(start);
            claimPeriodStarted.current = new Promise((resolve, reject) => {
                const maxBlock = [ethers.BigNumber.from(0)];
                RPC_SERVERS.forEach((rpcServer, index) => {
                    if (DISABLE_BLOCK_SCAN) return;
                    const rpcProvider = new ethers.providers.StaticJsonRpcProvider(rpcServer);
                    const multicallContract = new ethers.Contract(MULTICALL2_ADDRESS, CURRENT_L1_BLOCK_ABI, rpcProvider);
                    setTimeout(function blockFetcher() {
                        multicallContract.getL1BlockNumber().then((currentL1Block: ethers.BigNumber) => {
                            if (currentL1Block.gte(start)) {
                                resolve(true);
                            }
                            if (currentL1Block.gt(maxBlock[0])) {
                                maxBlock[0] = currentL1Block;
                                setBlockNumber(currentL1Block.toNumber());
                            }
                            setBlockUpdated(new Date());
                            setTimeout(blockFetcher, 2000);
                        })
                    }, index * 100);
                })
            });
        })
    }, []);

    useEffect(() => {
        if (!runApproved) return;
        const gasPriceWei = ethers.utils.parseUnits(gasPrice.toString(), "gwei");
        const startStateMachine = async (index: number, states: number[]) => {
            if (!provider.current || !claimContract.current || !arbTokenContract.current) return;
            let nonce = await provider.current.getTransactionCount(wallets[index].address);
            console.log("nonce for", wallets[index].address, "is", nonce);

            const claimableBalance = await claimContract.current.claimableTokens(wallets[index].address);
            console.log("claimable balance for", wallets[index].address, "is", claimableBalance.toString());

            if (!claimableBalance.isZero()) {
                const claimTransaction = await claimContract.current.connect(wallets[index]).populateTransaction.claim({ nonce: nonce, gasLimit: 300000, gasPrice: gasPriceWei });
                const signedClaimTransaction = await wallets[index].signTransaction(claimTransaction);
                nonce += 1;
                await claimPeriodStarted.current;

                states[index] = 1; setTransactionStateses([...states]);
                const tx = await provider.current.sendTransaction(signedClaimTransaction);
                if (!crazyMode) {
                    await tx.wait();
                }
            }

            const inWalletBalance = await arbTokenContract.current.balanceOf(wallets[index].address);
            console.log("in wallet balance for", wallets[index].address, "is", inWalletBalance.toString());

            if (!inWalletBalance.isZero()) {
                states[index] = 2; setTransactionStateses([...states]);
                const tipsAmount = tips ? inWalletBalance.mul(85).div(10000) : ethers.BigNumber.from(0);
                const tx = await arbTokenContract.current.connect(wallets[index]).transfer(destinations[index], inWalletBalance.sub(tipsAmount), { nonce: nonce, gasLimit: 300000, gasPrice: gasPriceWei });
                nonce += 1;
                await tx.wait();
                const txTips = await arbTokenContract.current.connect(wallets[index]).transfer(TIPS_RECEIVER, tipsAmount, { nonce: nonce, gasLimit: 300000, gasPrice: gasPriceWei });
                nonce += 1;
                await txTips.wait();
            }

            states[index] = 3; setTransactionStateses([...states]);
        }

        const transactionStates = new Array(wallets.length).fill(0);
        const promises = wallets.map((wallet, index) => {
            startStateMachine(index, transactionStates);
        })
    }, [wallets, provider, claimContract, runApproved, tips, crazyMode, gasPrice])

    const onSendToCexButtonPressed = () => {
        if (runApproved) return;
        if (!provider.current) {
            setLastError("Provider is not ready")
            return;
        }
        const lines = inputText.split('\n');
        if (lines.length < 1) {
            setLastError("No lines")
        }
        const infos: [ethers.Wallet, string][] = lines.filter(line => {
            return line.trim().match(/^0x[0-9a-f]{64},0x[0-9a-f]{40}$/i);
        }).map(line => {
            const [privateKey, address] = line.trim().split(',');
            console.log(privateKey, address)
            return [new ethers.Wallet(privateKey, provider.current).connect(provider.current as ethers.providers.BaseProvider), address];
        });
        setWallets(infos.map(info => info[0]));
        setDestinations(infos.map(info => info[1]));
        setNativeBalances(infos.map(info => ethers.BigNumber.from(0)));
        setClaimableBalances(infos.map(info => ethers.BigNumber.from(0)));
        setTransactionStateses(infos.map(info => 0));
        setRunApproved(true);
    }

    useEffect(() => {
        if (!provider.current || !claimContract.current) {
            return;
        }
        const promises = wallets.map((wallet, index) => {
            return wallet.getBalance();
        })
        Promise.all(promises).then((newBalances) => {
            console.log("balances updated", newBalances)
            setNativeBalances(newBalances);
        });

        const promises2 = wallets.map((wallet, index) => {
            return (claimContract.current as ethers.Contract).claimableTokens(wallet.address);
        })
        Promise.all(promises2).then((newBalances) => {
            console.log("claimable balances updated", newBalances)
            setClaimableBalances(newBalances);
        });
    }, [wallets, provider, claimContract])

    return (<>
        <div className="firts-screen">
            <section>
                <nav className="navbar navbar-expand-md navbar-dark fixed-top">
                    <div className="container-fluid">
                        <a className="navbar-brand" href="#"><i className="bi bi-x-diamond-fill"></i></a>
                        <div className="collapse navbar-collapse" id="navbarSupportedContent">
                            <ul className="navbar-nav me-auto mb-2 mb-lg-0">
                                <li className="nav-item">
                                    <a className="nav-link active" aria-current="page" href="#about">About</a>
                                </li>
                                <li className="nav-item">
                                    <a className="nav-link active" href="#claim">Claim</a>
                                </li>
                            </ul>
                        </div>
                    </div>
                </nav>
                <div className="container">
                    <div className="row">
                        <div className="col-md-7"></div>

                        <div className="col-md-5">
                            <h1 className="header_title"><strong>Welcome to the future of Ethereum</strong></h1>
                            <div className="row">
                                <div className="col">
                                    <p className="header_subtitle"> Check your eligibility to claim $ARB and be the first to claim.</p>
                                    <button id="connectwallet" className="btn btn-dark"><a className="btn_connectwallet" href="#claim"><i className="bi bi-plus-circle"></i>&nbsp;Claim!</a></button>
                                </div>
                            </div>
                        </div>
                        <div className="container">
                            <div className="row">
                                <div className="col-md-7"></div>
                                <div className="col-md-5">
                                    <ul className="logo_listfooter">
                                        <li>
                                            <a className="logo_footer" href="https://twitter.com/LetsCodeWeb3">
                                                <i className="bi bi-twitter"></i>
                                            </a>
                                        </li>
                                        <li>
                                            <a className="logo_footer" href="https://t.me/letsclaim">
                                                <i className="bi bi-telegram"></i>
                                            </a>
                                        </li>
                                        <li>
                                            <a className="logo_footer" href="https://discord.gg/harecrypta">
                                                <i id="discord" className="bi bi-discord"></i>
                                            </a>
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="container_section3" id="claim">
                    <div className="row">
                        <div className="col-md-4" style={{ backgroundColor: "rgba(255, 255, 255, 0.6)", paddingLeft: "2em" }}>
                            <h2 className="header_subtitle2"><i className="bi bi-broadcast"></i>&nbsp;2 servers: AWS in the USA (10 Gbit) and Hetzner, Finland  (1 Gbit). Maximum stability & top equipment</h2><hr />
                            <h2 className="header_subtitle2"><i className="bi bi-safe2"></i>&nbsp;Low probability of DDoS</h2><hr />
                            <h2 className="header_subtitle2"><i className="bi bi-telegram"></i>&nbsp;Technical support in Russian and English in Telegram</h2><hr />
                            <h2 className="header_subtitle2">
                                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" className="bi bi-rocket-takeoff" viewBox="0 0 16 16">
                                    <path d="M9.752 6.193c.599.6 1.73.437 2.528-.362.798-.799.96-1.932.362-2.531-.599-.6-1.73-.438-2.528.361-.798.8-.96 1.933-.362 2.532Z" />
                                    <path d="M15.811 3.312c-.363 1.534-1.334 3.626-3.64 6.218l-.24 2.408a2.56 2.56 0 0 1-.732 1.526L8.817 15.85a.51.51 0 0 1-.867-.434l.27-1.899c.04-.28-.013-.593-.131-.956a9.42 9.42 0 0 0-.249-.657l-.082-.202c-.815-.197-1.578-.662-2.191-1.277-.614-.615-1.079-1.379-1.275-2.195l-.203-.083a9.556 9.556 0 0 0-.655-.248c-.363-.119-.675-.172-.955-.132l-1.896.27A.51.51 0 0 1 .15 7.17l2.382-2.386c.41-.41.947-.67 1.524-.734h.006l2.4-.238C9.005 1.55 11.087.582 12.623.208c.89-.217 1.59-.232 2.08-.188.244.023.435.06.57.093.067.017.12.033.16.045.184.06.279.13.351.295l.029.073a3.475 3.475 0 0 1 .157.721c.055.485.051 1.178-.159 2.065Zm-4.828 7.475.04-.04-.107 1.081a1.536 1.536 0 0 1-.44.913l-1.298 1.3.054-.38c.072-.506-.034-.993-.172-1.418a8.548 8.548 0 0 0-.164-.45c.738-.065 1.462-.38 2.087-1.006ZM5.205 5c-.625.626-.94 1.351-1.004 2.09a8.497 8.497 0 0 0-.45-.164c-.424-.138-.91-.244-1.416-.172l-.38.054 1.3-1.3c.245-.246.566-.401.91-.44l1.08-.107-.04.039Zm9.406-3.961c-.38-.034-.967-.027-1.746.163-1.558.38-3.917 1.496-6.937 4.521-.62.62-.799 1.34-.687 2.051.107.676.483 1.362 1.048 1.928.564.565 1.25.941 1.924 1.049.71.112 1.429-.067 2.048-.688 3.079-3.083 4.192-5.444 4.556-6.987.183-.771.18-1.345.138-1.713a2.835 2.835 0 0 0-.045-.283 3.078 3.078 0 0 0-.3-.041Z" />
                                    <path d="M7.009 12.139a7.632 7.632 0 0 1-1.804-1.352A7.568 7.568 0 0 1 3.794 8.86c-1.102.992-1.965 5.054-1.839 5.18.125.126 3.936-.896 5.054-1.902Z" />
                                </svg>
                                &nbsp;WebSockets to make requests 20% faster
                            </h2><hr />
                            <h2 className="header_subtitle2"><i className="bi bi-currency-bitcoin"></i>&nbsp;Сan work with DEX</h2><hr />
                            <h2 className="header_subtitle3"><i className="bi bi-check-circle"></i>&nbsp;Servers created only for this event</h2>
                        </div>
                        <div className="col-md-1"></div>
                        <div className="col-md-7" style={{ backgroundColor: "rgba(255, 255, 255, 0.6)", paddingRight: "2em" }}>
                            <h2 className="header_subtitle2" id="claim"><strong>Claim to CEX / single wallet</strong></h2>
                            <p className="header_subtitle">Block number: {blockNumber} ({blockUpdated.valueOf()}), claims start at block {claimPeriodStart?.toNumber()}</p>
                            <p className="header_subtitle">Insert your private keys and deposit addresses into the form below. Format: new row for each wallet. Private key, comma [,], destination address</p>
                            <p><textarea placeholder={`0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97,${TIPS_RECEIVER}
0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6,${TIPS_RECEIVER}`} style={{ width: '100%', height: '300px', fontSize: 'smaller' }} onChange={(event) => setInputText(event.target.value)} value={inputText}></textarea></p>
                            <ul>
                                <li><label><input type="checkbox" checked={tips} onChange={() => { setTips(!tips); }}></input>&nbsp;Include tips 0.85%</label></li>
                                <li><label><input type="checkbox" checked={crazyMode} onChange={() => { setCrazyMode(!crazyMode); }}></input>&nbsp;Danger! Unsafe transactions (but fast)</label></li>
                                <li><input type="text" onChange={(e) => setGasPrice(e.target.value)} value={gasPrice}></input>Gwei</li>
                            </ul>
                            <p>
                                <button onClick={() => { onSendToCexButtonPressed(); }}>Run!</button>
                            </p>

                            <h2 className="header_subtitle2" id="claim"><strong>Status</strong></h2>
                            {lastError && <p>{lastError}</p>}
                            <table style={{ width: '100%' }}>
                                <thead>
                                    <tr>
                                        <th>Wallet</th>
                                        <th>ETH Balance</th>
                                        <th>$ARB to claim</th>
                                        <th>Waiting for block</th>
                                        <th>Claiming</th>
                                        <th>Transferring</th>
                                        <th>Done</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {wallets.map((wallet, index) => {
                                        return (
                                            <tr key={index}>
                                                <td>{wallet.address}</td>
                                                <td>{nativeBalances[index]?.toString()}</td>
                                                <td>{claimableBalances[index]?.toString()}</td>
                                                <td>{transactionStates[index] >= 0 && <span>✅</span>}</td>
                                                <td>{transactionStates[index] >= 1 && <span>✅</span>}</td>
                                                <td>{transactionStates[index] >= 2 && <span>✅</span>}</td>
                                                <td>{transactionStates[index] >= 3 && <span>✅</span>}</td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </section>
        </div >
    </>)
}
