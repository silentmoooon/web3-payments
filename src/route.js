/*#if _EVM

import { dripAssets } from '@depay/web3-assets-evm'
import Exchanges from '@depay/web3-exchanges-evm'
import Token from '@depay/web3-tokens-evm'

/*#elif _SVM

import { dripAssets } from '@depay/web3-assets-svm'
import Exchanges from '@depay/web3-exchanges-svm'
import Token from '@depay/web3-tokens-svm'

//#else */

import {dripAssets} from '@depay/web3-assets'
import Exchanges from '@depay/web3-exchanges'
import Token from '@depay/web3-tokens'

//#endif

import Blockchains from '@depay/web3-blockchains'
import routers from './routers'
import throttle from 'lodash/throttle'
import {ethers} from 'ethers'
import {getBlockchainCost} from './costs'
import {getTransaction} from './transaction'
import {supported} from './blockchains'

class PaymentRoute {
    constructor({
                    blockchain,
                    fromAddress,
                    fromTokens,
                    toAddress,
                    toTokens, fee,

                }) {
        this.blockchain = blockchain
        this.fromAddress = fromAddress
        this.fromTokens = fromTokens || []

        this.toTokens = toTokens || []
        this.toAddress = toAddress
        this.fee = fee
        this.fromTokens.forEach(fromToken => {
            fromToken.fromAmount = (fromToken.fromAmount || fromToken.toAmount)?.toString()
            fromToken.toAmount = fromToken.toAmount?.toString()
            fromToken.exchangeRoutes = fromToken.exchangeRoutes || []
        })
        this.getTransaction = async (options) => {
            return await getTransaction({paymentRoute: this, options})
        }
    }
}

function convertToRoutes({assets, accept, from}) {
    return Promise.all(assets.map(async (asset) => {
        let relevantConfigurations = accept.filter((configuration) => (configuration.blockchain === asset.blockchain))
        let fromToken = new Token(asset)
        return Promise.all(relevantConfigurations.map(async (configuration) => {
            if (configuration.token && configuration.amount) {
                let blockchain = configuration.blockchain
                let fromDecimals = asset.decimals
                let toToken = new Token({blockchain, address: configuration.token})
                let toDecimals = await toToken.decimals()
                let toAmount = (await toToken.BigNumber(configuration.amount)).toString()

                return new PaymentRoute({
                    blockchain,
                    fromTokens: [{
                        fromToken: fromToken,
                        fromDecimals: fromDecimals,
                        fromBalance: asset.balance,
                        toToken: toToken,
                        toAmount: toAmount,
                        toDecimals: toDecimals,
                    }],
                    fromAddress: from[configuration.blockchain],
                    toAddress: configuration.toAddress,
                    fee: configuration.fee

                })
            } else if (configuration.fromToken && configuration.fromAmount && fromToken.address.toLowerCase() === configuration.fromToken.toLowerCase()) {
                let blockchain = configuration.blockchain
                let fromAmount = (await fromToken.BigNumber(configuration.fromAmount)).toString()
                let fromDecimals = asset.decimals
                let toToken = new Token({blockchain, address: configuration.toToken})
                let toDecimals = await toToken.decimals()

                return new PaymentRoute({
                    blockchain,
                    fromTokens: [{
                        fromToken: fromToken,
                        fromAmount: fromAmount,
                        fromDecimals: fromDecimals,
                        fromBalance: asset.balance,
                        toToken: toToken,
                        toDecimals: toDecimals,
                    }],
                    fromAddress: from[configuration.blockchain],
                    toAddress: configuration.toAddress,
                    fee: configuration.fee
                })
            }
        }))
    })).then((routes) => routes.flat().filter(el => el))
}

function assetsToRoutes({assets, blacklist, accept, from}) {
    return Promise.resolve(filterBlacklistedAssets({assets, blacklist}))
        .then((assets) => convertToRoutes({assets, accept, from}))
        .then((routes) => addDirectTransferStatus({routes}))
        .then(addExchangeRoutes)
        .then(filterNotRoutable)
        .then(filterInsufficientBalance)
        .then((routes) => addRouteAmounts({routes}))
        .then(addApproval)
        .then(sortPaymentRoutes)
        //.then(filterDuplicateFromTokens)
        .then((routes) => routes.map((route) => new PaymentRoute(route)))
}

function route({accept, from, whitelist, blacklist, drip}) {
    if (accept.some((accept) => {
        return accept && accept.fee && typeof (accept.fee.amount) == 'string' && accept.fee.amount.match(/\.\d\d+\%/)
    })) {
        throw ('Only up to 1 decimal is supported for fee amounts!')
    }

    return new Promise(async (resolveAll, rejectAll) => {

        let priority = []
        let blockchains = []
        if (whitelist) {
            for (const blockchain in whitelist) {
                (whitelist[blockchain] || []).forEach((address) => {
                    blockchains.push(blockchain)
                    priority.push({blockchain, address})
                })
            }
        } else {
            accept.forEach((accepted) => {
                blockchains.push(accepted.blockchain)
                priority.push({blockchain: accepted.blockchain, address: accepted.token || accepted.toToken})
            })
        }

        // add native currency as priority if does not exist already
        [...new Set(blockchains)].forEach((blockchain) => {
            if (
                !priority.find((priority) => priority.blockchain === blockchain && priority.address === Blockchains[blockchain].currency.address) &&
                (!whitelist || (whitelist && whitelist[blockchain] && whitelist[blockchain].includes(Blockchains[blockchain].currency.address)))
            ) {
                priority.push({blockchain, address: Blockchains[blockchain].currency.address})
            }
        })

        priority.sort((a, b) => {

            // cheaper blockchains are more cost efficient
            if (getBlockchainCost(a.blockchain) < getBlockchainCost(b.blockchain)) {
                return -1 // a wins
            }
            if (getBlockchainCost(b.blockchain) < getBlockchainCost(a.blockchain)) {
                return 1 // b wins
            }

            // NATIVE input token is more cost efficient
            if (a.address.toLowerCase() === Blockchains[a.blockchain].currency.address.toLowerCase()) {
                return -1 // a wins
            }
            if (b.address.toLowerCase() === Blockchains[b.blockchain].currency.address.toLowerCase()) {
                return 1 // b wins
            }

            return 0
        })

        const sortPriorities = (priorities, a, b) => {
            if (!priorities || priorities.length === 0) {
                return 0
            }
            let priorityIndexOfA = priorities.indexOf([a.blockchain, a.address.toLowerCase()].join(''))
            let priorityIndexOfB = priorities.indexOf([b.blockchain, b.address.toLowerCase()].join(''))

            if (priorityIndexOfA !== -1 && priorityIndexOfB === -1) {
                return -1 // a wins
            }
            if (priorityIndexOfB !== -1 && priorityIndexOfA === -1) {
                return 1 // b wins
            }

            if (priorityIndexOfA < priorityIndexOfB) {
                return -1 // a wins
            }
            if (priorityIndexOfB < priorityIndexOfA) {
                return 1 // b wins
            }
            return 0
        }

        let drippedIndex = 0
        const dripQueue = []
        const dripped = []
        const priorities = priority.map((priority) => [priority.blockchain, priority.address.toLowerCase()].join(''))
        const thresholdToFirstDripIfNo1PriorityWasNotFirst = 3000
        const now = () => Math.ceil(new Date())
        const time = now()
        setTimeout(() => {
            dripQueue.forEach((asset) => dripRoute(route, false))
        }, thresholdToFirstDripIfNo1PriorityWasNotFirst)
        const dripRoute = (route, recursive = true) => {
            try {
                const asset = {blockchain: route.blockchain, address: route.fromToken.address}
                const assetAsKey = [asset.blockchain, asset.address.toLowerCase()].join('')
                const timeThresholdReached = now() - time > thresholdToFirstDripIfNo1PriorityWasNotFirst
                if (dripped.indexOf(assetAsKey) > -1) {
                    return
                }
                if (priorities.indexOf(assetAsKey) === drippedIndex) {
                    dripped.push(assetAsKey)
                    drip(route)
                    drippedIndex += 1
                    if (!recursive) {
                        return
                    }
                    dripQueue.forEach((asset) => dripRoute(route, false))
                } else if (drippedIndex >= priorities.length || timeThresholdReached) {
                    if (priorities.indexOf(assetAsKey) === -1) {
                        dripped.push(assetAsKey)
                        drip(route)
                    } else if (drippedIndex >= priorities.length || timeThresholdReached) {
                        dripped.push(assetAsKey)
                        drip(route)
                    }
                } else if (!dripQueue.find((queued) => queued.blockchain === asset.blockchain && queued.address.toLowerCase() === asset.address.toLowerCase())) {
                    dripQueue.push(asset)
                    dripQueue.sort((a, b) => sortPriorities(priorities, a, b))
                }
            } catch {
            }
        }

        const allAssets = await dripAssets({
            accounts: from,
            priority,
            only: whitelist,
            exclude: blacklist,
            drip: !drip ? undefined : (asset) => {
                assetsToRoutes({assets: [asset], blacklist, accept, from}).then((routes) => {
                    if (routes?.length) {
                        dripRoute(routes[0])
                    }
                })
            }
        })

        let allPaymentRoutes = (await assetsToRoutes({assets: allAssets, blacklist, accept, from}) || [])
        allPaymentRoutes.assets = allAssets
        resolveAll(allPaymentRoutes)
    })
}

let filterBlacklistedAssets = ({assets, blacklist}) => {
    if (blacklist == undefined) {
        return assets
    } else {
        return assets.filter((asset) => {
            if (blacklist[asset.blockchain] == undefined) {
                return true
            } else {
                return !blacklist[asset.blockchain].find((blacklistedAddress) => {
                    return blacklistedAddress.toLowerCase() == asset.address.toLowerCase()
                })
            }
        })
    }
}

let addExchangeRoutes = async (routes) => {
    return await Promise.all(routes.map(async (route) => {
            return await Promise.all(route.fromTokens.map((fromToken) => {
                    if (fromToken.directTransfer) {
                        return []
                    }
                    if (fromToken.toToken && fromToken.toAmount) {
                        return Exchanges.route({
                            blockchain: route.blockchain,
                            tokenIn: fromToken.fromToken.address,
                            tokenOut: fromToken.toToken.address,
                            amountOutMin: fromToken.toAmount,
                            fromAddress: route.fromAddress,
                            toAddress: route.toAddress
                        }).then((exchangeRoutes) => {
                            return exchangeRoutes
                        })
                    } else if (fromToken.tokenAddress && fromToken.amount) {
                        return Exchanges.route({
                            blockchain: route.blockchain,
                            tokenIn: fromToken.fromToken.address,
                            tokenOut: fromToken.toToken.address,
                            amountIn: fromToken.fromAmount,
                            fromAddress: route.fromAddress,
                            toAddress: route.toAddress
                        }).then((exchangeRoutes) => {
                            return exchangeRoutes
                        })
                    }
                })
            ).then((exchangeRoutes) => {
                route.fromTokens.forEach((fromToken, index) => {
                    fromToken.exchangeRoutes = exchangeRoutes[index]
                })
                return route
            })

        })
    ).then((routes) => {
        return routes
    })
}

let filterNotRoutable = (routes) => {
    return routes.map((route) => {
        route.fromTokens = route.fromTokens.filter((fromToken) => {
            return (
                fromToken.exchangeRoutes.length !== 0 ||
                fromToken.fromToken.address.toLowerCase() === fromToken.toToken.address.toLowerCase() // direct transfer always possible
            )
        })
        return route
    })
}

let filterInsufficientBalance = async (routes) => {
    return routes.map((route) => {
        route.fromTokens = route.fromTokens.filter((fromToken) => {
            if (fromToken.fromToken.address.toLowerCase() === fromToken.toToken.address.toLowerCase()) {
                return ethers.BigNumber.from(fromToken.fromBalance).gte(ethers.BigNumber.from(fromToken.toAmount))
            } else if (fromToken.fromAmount && fromToken.toAmount) {
                return ethers.BigNumber.from(fromToken.fromBalance).gte(ethers.BigNumber.from(fromToken.exchangeRoutes[0].amountInMax))
            } else if (fromToken.exchangeRoutes[0] && fromToken.exchangeRoutes[0].amountIn) {
                return ethers.BigNumber.from(fromToken.fromBalance).gte(ethers.BigNumber.from(fromToken.exchangeRoutes[0].amountIn))
            }
        })
        return route
    })
}

let addApproval = (routes) => {
    return Promise.all(routes.map(
        (route) => {
            Promise.all(route.fromTokens.map((fromToken) => {
                if (route.blockchain === 'solana') {

                    return Promise.resolve(Blockchains.solana.maxInt)

                    //return Promise.resolve(Blockchains.solana.maxInt)
                } else {
                    return fromToken.fromToken.allowance(route.fromAddress, routers[route.blockchain].address).catch(() => {

                    })


                }
            })).then(
                (allowances) => {
                    route.fromTokens.forEach((fromToken,index) => {
                        if (
                            (
                                allowances[index].allowance === undefined ||
                                fromToken.directTransfer ||
                                fromToken.fromToken.address.toLowerCase() === Blockchains[route.blockchain].currency.address.toLowerCase() ||
                                route.blockchain === 'solana'
                            )
                        ) {
                            fromToken.approvalRequired = false
                        } else {
                            fromToken.currentAllowance = ethers.BigNumber.from(allowances[index])
                            fromToken.approvalRequired = ethers.BigNumber.from(fromToken.fromAmount).gte(ethers.BigNumber.from(allowances[index]))
                            if (fromToken.approvalRequired) {
                                fromToken.approvalTransaction = {
                                    blockchain: route.blockchain,
                                    to: fromToken.fromToken.address,
                                    api: Token[route.blockchain].DEFAULT,
                                    method: 'approve',
                                    params: [routers[route.blockchain].address, Blockchains[route.blockchain].maxInt]
                                }
                            }
                        }
                       // return fromToken
                    })

                },

            )
            return route;
        }
    ))
}

let addDirectTransferStatus = ({routes}) => {
    return routes.map((route) => {
        if (supported.evm.includes(route.blockchain)) {
            route.fromTokens.forEach((fromToken) => {
                fromToken.directTransfer = fromToken.fromToken.address.toLowerCase() === fromToken.toToken.address.toLowerCase()
            })
            //route.directTransfer = route.fromToken.address.toLowerCase() == route.toToken.address.toLowerCase() && route.fee == undefined
        } else if (route.blockchain === 'solana') {
            route.fromTokens.forEach((fromToken) => {
                fromToken.directTransfer = fromToken.fromToken.address.toLowerCase() === fromToken.toToken.address.toLowerCase()
            })
        }
        return route
    })
}

let calculateAmounts = ({fromToken, exchangeRoute}) => {
    let fromAmount
    let toAmount
    let feeAmount
    if (exchangeRoute) {
        if (exchangeRoute && exchangeRoute.exchange.wrapper) {
            fromAmount = exchangeRoute.amountIn.toString()
            toAmount = subtractFee({amount: exchangeRoute.amountOutMin.toString(), fromToken})
        } else {
            fromAmount = exchangeRoute.amountIn.toString()
            toAmount = subtractFee({amount: exchangeRoute.amountOutMin.toString(), fromToken})
        }
    } else {
        fromAmount = fromToken.fromAmount
        toAmount = subtractFee({amount: fromToken.fromAmount, fromToken})
    }
    if (fromToken.fee) {
        feeAmount = getFeeAmount({fromToken})
    }
    return {fromAmount, toAmount, feeAmount}
}

let subtractFee = ({amount, fromToken}) => {
    if (fromToken.fee) {
        let feeAmount = getFeeAmount({fromToken})
        return ethers.BigNumber.from(amount).sub(feeAmount).toString()
    } else {
        return amount
    }
}

let getFeeAmount = ({fromToken}) => {
    if (typeof fromToken.fee.amount == 'string' && fromToken.fee.amount.match('%')) {
        return ethers.BigNumber.from(fromToken.toAmount).mul(parseFloat(fromToken.fee.amount) * 10).div(1000).toString()
    } else if (typeof fromToken.fee.amount == 'string') {
        return fromToken.fee.amount
    } else if (typeof fromToken.fee.amount == 'number') {
        return ethers.utils.parseUnits(fromToken.fee.amount.toString(), fromToken.toDecimals).toString()
    } else {
        throw ('Unknown fee amount type!')
    }
}

let addRouteAmounts = ({routes}) => {
    return routes.map((route) => {
        let map = new Map();
        if (supported.evm.includes(route.blockchain)) {
            route.fromTokens.forEach((fromToken) => {
                if (fromToken.directTransfer && !fromToken.fee) {
                    fromToken.fromAmount = fromToken.toAmount
                } else {
                    fromToken.fee = route.fee;
                    let {fromAmount, toAmount, feeAmount} = calculateAmounts({
                        fromToken: fromToken,
                        exchangeRoute: fromToken.exchangeRoutes[0]
                    })
                    fromToken.fromAmount = fromAmount
                    fromToken.toAmount = toAmount
                    if (fromToken.fee) {
                        fromToken.feeAmount = feeAmount
                    }
                }
                var toToken = {};
                if (map.has(fromToken.toToken)) {
                    toToken = map.get(fromToken.toToken);
                    toToken.amount += fromToken.toAmount;
                    toToken.feeAmount += fromToken.feeAmount ? fromToken.feeAmount : 0;

                } else {
                    toToken.toToken = fromToken.toToken;
                    toToken.amount = fromToken.toAmount;
                    toToken.feeAmount = fromToken.feeAmount ? fromToken.feeAmount : 0;

                }
                map.set(fromToken.toToken, toToken);
            })

        } else if (supported.solana.includes(route.blockchain)) {

            route.fromTokens.forEach((fromToken) => {
                let {fromAmount, toAmount, feeAmount} = calculateAmounts({
                    paymentRoute: fromToken,
                    exchangeRoute: fromToken.exchangeRoutes[0]
                })
                fromToken.fromAmount = fromAmount
                fromToken.toAmount = toAmount
                if (fromToken.fee) {
                    fromToken.feeAmount = feeAmount
                }
                var toToken = {};
                if (map.has(fromToken.toToken)) {
                    toToken = map.get(fromToken.toToken);
                    toToken.amount += fromToken.toAmount;
                    toToken.feeAmount += fromToken.feeAmount;

                } else {
                    toToken.toToken = fromToken.toToken;
                    toToken.amount = fromToken.toAmount;
                    toToken.feeAmount = fromToken.feeAmount;

                }
                map.set(fromToken.toToken, toToken);
            });

        }
        route.toTokens = map.values();
        return route
    })
}

let filterDuplicateFromTokens = (routes) => {
    return routes.filter((routeA, indexA) => {
        let otherMoreEfficientRoute = routes.find((routeB, indexB) => {
            if (routeA.fromToken.address != routeB.fromToken.address) {
                return false
            }
            if (routeA.fromToken.blockchain != routeB.fromToken.blockchain) {
                return false
            }
            if (routeB.directTransfer && !routeA.directTransfer) {
                return true
            }
            if (ethers.BigNumber.from(routeB.fromAmount).lt(ethers.BigNumber.from(routeA.fromAmount)) && !routeA.directTransfer) {
                return true
            }
            if (routeB.fromAmount == routeA.fromAmount && indexB < indexA) {
                return true
            }
        })

        return otherMoreEfficientRoute == undefined
    })
}

let sortPaymentRoutes = (routes) => {
    let aWins = -1
    let bWins = 1
    let equal = 0
    return routes.sort((a, b) => {

        // cheaper blockchains are more cost-efficien
        if (getBlockchainCost(a.blockchain) < getBlockchainCost(b.blockchain)) {
            return aWins
        }
        if (getBlockchainCost(b.blockchain) < getBlockchainCost(a.blockchain)) {
            return bWins
        }
        let aCount = 0;
        let bCount = 0;
        a.fromTokens.forEach((fromToken) => {
            if (fromToken.directTransfer) {
                aCount++
            }
        })
        b.fromTokens.forEach((fromToken) => {
            if (fromToken.directTransfer) {
                bCount++
            }
        })
        // direct transfer is always more cost-efficient
        if (aCount / a.fromTokens.length >= bCount / b.fromTokens.length) {
            return aWins
        } else {
            return bWins
        }
        let aApprovalRequired = 0;
        let bApprovalRequired = 0;
        a.fromTokens.forEach((fromToken) => {
            if (fromToken.approvalRequired) {
                aApprovalRequired++
            }
        })
        b.fromTokens.forEach((fromToken) => {
            if (fromToken.approvalRequired) {
                bApprovalRequired++
            }
        })

        // requiring approval is less cost efficient
        if (aApprovalRequired < bApprovalRequired) {
            return aWins
        } else {
            return bWins
        }


        // NATIVE -> WRAPPED is more cost efficient that swapping to another token
        /*  if (JSON.stringify([a.fromToken.address.toLowerCase(), a.toToken.address.toLowerCase()].sort()) == JSON.stringify([Blockchains[a.blockchain].currency.address.toLowerCase(), Blockchains[a.blockchain].wrapped.address.toLowerCase()].sort())) {
              return aWins
          }
          if (JSON.stringify([b.fromToken.address.toLowerCase(), b.toToken.address.toLowerCase()].sort()) == JSON.stringify([Blockchains[b.blockchain].currency.address.toLowerCase(), Blockchains[b.blockchain].wrapped.address.toLowerCase()].sort())) {
              return bWins
          }

          // NATIVE input token is more cost efficient
          if (a.fromToken.address.toLowerCase() == Blockchains[a.blockchain].currency.address.toLowerCase()) {
              return aWins
          }
          if (b.fromToken.address.toLowerCase() == Blockchains[b.blockchain].currency.address.toLowerCase()) {
              return bWins
          }

          if (a.fromToken.address < b.fromToken.address) {
              return aWins
          } else {
              return bWins
          }*/
    })
}

export default route
